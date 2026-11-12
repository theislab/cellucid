/**
 * A field released from memory is no field half there. A hidden page gives
 * back every inactive field (`app/page-memory.js`, `field/residency.js`), so
 * any tab switch releases what was colored by earlier: its arrays go, what
 * was set on it stays, and it is read again when used. These specs walk that
 * on a real page and a Zarr store read lazily: the tab is hidden by the page's
 * own event, and every later visibility pass, undo, jump, coloring and Verify
 * goes on; a filter that narrows and a user's own column stay resident; and a
 * read that fails (the host's fault, or a host that really rewrote the store)
 * is one plain sentence, with what was shown still shown. A host that only
 * redeployed the same bytes under new validators is no failure at all.
 *
 * Owner's report (Suo on www.cellucid.com, 0.9.7): "Verifying the branch
 * failed: Observation category field 4 requires exact dataset-length codes."
 */
import { expect, test } from './helpers/test.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { takeSteps, waitForHistory } from './helpers/state-history.mjs';

const CATALOG = appUrl('/tests/browser/fixtures/forms-catalog/');
const DATASET_URL = `/?sampleCatalog=${encodeURIComponent(CATALOG)}&dataset=forms-zarr&acceptance=history-released-fields-ci`;
const STORE = /forms-zarr\.zarr\//;
const PSEUDOTIME_VALUES = /forms-zarr\.zarr\/obs\/pseudotime\/0$/;
const STAGE = Object.freeze({ source: 'obs', key: 'stage' });
const PSEUDOTIME = Object.freeze({ source: 'obs', key: 'pseudotime' });

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/**
 * Open the store. It opens colored by stage (its first coloring,
 * `app/first-coloring.js`, part of the opening): a step to pseudotime leaves
 * stage the field colored by earlier.
 */
async function openStore(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openPhoneSheet(page);
  await waitForHistory(page);
  await page.locator('#state-section').evaluate(section => { section.open = true; });
  expect(await page.evaluate(() => window._cellucidState.getActiveField()?.key)).toBe('stage');
}

/** Switch to another tab and back: the page's own event, as the browser sends it. */
function switchTabAway(page) {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** One field as the state holds it. */
function fieldFacts(page, key) {
  return page.evaluate(name => {
    const field = window._cellucidState.obsData.fields.find(each => each.key === name);
    return { loaded: field.loaded, arrays: ArrayBuffer.isView(field.codes) || ArrayBuffer.isView(field.values) };
  }, key);
}

/** What the person is looking at, and which step of which tracker it is. */
function shownNow(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const history = window._cellucidHistories.current();
    return {
      active: state.getActiveField()?.key ?? null,
      filtered: state.filteredCount.shown,
      shownCells: state.categoryTransparency.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0),
      colors: Array.from(state.colorsArray).join(),
      tracker: history.active.name,
      trackers: history.trackers().length,
      head: history.active.headId,
    };
  });
}

/** Verify a branch from its own menu in the State panel. */
async function verifyFromMenu(page, branch = 'b0') {
  const more = page.locator(`#history-branches .history-branch[data-branch="${branch}"] .history-branch-more`);
  // The button toggles the list: asked of the list, not of a row, which is not
  // visible while the list draws itself again (a second click closed it).
  const list = page.locator('#history-branch-btn');
  if (await list.getAttribute('aria-expanded') !== 'true') await list.click();
  await expect(list).toHaveAttribute('aria-expanded', 'true');
  await more.click();
  await page.getByRole('menuitem', { name: 'Verify' }).click();
}

const notice = (page, text) => page.locator('#notification-center .notification', { hasText: text });

test('a tab switch releases what was colored earlier, and Verify, undo, jump and coloring go on', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  await openStore(page);
  const [colored] = await takeSteps(page, [['color.by', { field: PSEUDOTIME }]]);

  await switchTabAway(page);
  // The release is real: the field shown earlier holds no codes now.
  expect(await fieldFacts(page, 'stage')).toEqual({ loaded: false, arrays: false });
  const before = await shownNow(page);

  await verifyFromMenu(page);
  await expect(notice(page, 'reproduced exactly (1 step)')).toBeVisible();
  await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
  await expect.poll(() => shownNow(page)).toEqual(before);

  // Every other move goes through the same pass.
  await switchTabAway(page);
  await page.evaluate(() => window._cellucidHistories.current().undo());
  expect((await shownNow(page)).active).toBe('stage');
  expect((await shownNow(page)).head).toBe('s0');
  await page.evaluate(() => window._cellucidHistories.current().redo());
  expect((await shownNow(page)).head).toBe(colored);
  await switchTabAway(page);
  await page.evaluate(id => window._cellucidHistories.current().jump(id), 's0');
  expect((await shownNow(page)).active).toBe('stage');
  // Pseudotime, released by the switch below, is read again when colored by.
  await switchTabAway(page);
  expect(await fieldFacts(page, 'pseudotime')).toEqual({ loaded: false, arrays: false });
  await takeSteps(page, [['color.by', { field: PSEUDOTIME }]]);
  expect((await shownNow(page)).active).toBe('pseudotime');
  expect(errors).toEqual([]);
});

test('a continuous field released is the same: its full range needs no values', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  await openStore(page);
  await takeSteps(page, [['color.by', { field: PSEUDOTIME }], ['color.by', { field: STAGE }]]);
  await switchTabAway(page);
  expect(await fieldFacts(page, 'pseudotime')).toEqual({ loaded: false, arrays: false });
  const before = await shownNow(page);
  await verifyFromMenu(page);
  await expect(notice(page, 'reproduced exactly (2 steps)')).toBeVisible();
  await expect.poll(() => shownNow(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('every branch of a branched history verifies after a tab switch', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  await openStore(page);
  await takeSteps(page, [['color.by', { field: PSEUDOTIME }]]);
  // Back to the opening, colored by stage, and a branch from there.
  await page.evaluate(id => window._cellucidHistories.current().jump(id), 's0');
  await takeSteps(page, [['filter.category.visibility', { field: STAGE, categories: ['early'], visible: false }]]);
  const before = await shownNow(page);
  expect(await page.evaluate(() => window._cellucidHistories.current().active.branches.size)).toBe(2);
  await switchTabAway(page);
  for (const branch of ['b0', 'b1']) {
    await verifyFromMenu(page, branch);
    await expect(notice(page, 'reproduced exactly').first()).toBeVisible();
    await page.locator('#notification-center .notification', { hasText: 'reproduced exactly' }).first().evaluate(card => card.remove());
    await expect.poll(() => shownNow(page)).toEqual(before);
    await switchTabAway(page);
  }
  await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('whatever narrows a filter keeps its arrays through a tab switch: a hidden category, the cell count kept, a hidden field\'s filter', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  await openStore(page);
  // Colored by stage as it opens.
  await takeSteps(page, [
    ['filter.category.cell-count', { field: STAGE, category: 'early', count: 2, seed: 7 }],
    ['color.by', { field: PSEUDOTIME }],
  ]);
  const limited = await shownNow(page);
  expect(limited.shownCells).toBeLessThan(48);
  await switchTabAway(page);
  expect(await fieldFacts(page, 'stage')).toEqual({ loaded: true, arrays: true });
  await takeSteps(page, [['filter.category.cell-count', { field: STAGE, category: 'early', count: null }]]);
  await takeSteps(page, [['filter.category.visibility', { field: STAGE, categories: ['mature'], visible: false }]]);
  const hidden = await shownNow(page);
  await switchTabAway(page);
  expect(await fieldFacts(page, 'stage')).toEqual({ loaded: true, arrays: true });
  expect((await shownNow(page)).shownCells).toBe(hidden.shownCells);
  // The check stays: a filter that narrows with no codes to read is refused, never drawn as if it passed.
  const refused = await page.evaluate(() => {
    const state = window._cellucidState;
    const field = state.obsData.fields.find(each => each.key === 'stage');
    const { codes, loaded } = field;
    delete field.codes;
    field.loaded = false;
    try {
      state.computeGlobalVisibility();
      return null;
    } catch (error) {
      return error.message;
    } finally {
      Object.assign(field, { codes, loaded });
    }
  });
  expect(refused).toMatch(/requires exact dataset-length codes/);
  expect(errors).toEqual([]);
});

test('kept views: a field one view shows stays, the others are released in every view, and Verify goes on', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  await openStore(page);
  // The view kept shows the opening's stage.
  await takeSteps(page, [['view.keep', {}], ['color.by', { field: PSEUDOTIME }]]);
  await switchTabAway(page);
  expect(await fieldFacts(page, 'stage')).toEqual({ loaded: true, arrays: true });
  const before = await shownNow(page);
  await verifyFromMenu(page);
  await expect(notice(page, 'reproduced exactly (2 steps)')).toBeVisible();
  await expect.poll(() => shownNow(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('a user\'s own column survives a tab switch: no file could give it back', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  await openStore(page);
  const count = await page.evaluate(() => window._cellucidState.pointCount);
  await takeSteps(page, [
    ['field.duplicate', { field: STAGE, name: 'my stage' }],
    ['field.push', { key: 'pushed', kind: 'continuous', categories: null, n_obs: count, cells: null, values: Array.from({ length: count }, (_, cell) => cell) }],
    ['color.by', { field: { source: 'obs', key: 'my stage' } }],
    ['color.by', { field: { source: 'obs', key: 'pushed' } }],
    ['color.by', { field: PSEUDOTIME }],
  ]);
  await switchTabAway(page);
  expect(await fieldFacts(page, 'my stage')).toEqual({ loaded: true, arrays: true });
  expect(await fieldFacts(page, 'pushed')).toEqual({ loaded: true, arrays: true });
  await takeSteps(page, [['color.by', { field: { source: 'obs', key: 'my stage' } }], ['color.by', { field: { source: 'obs', key: 'pushed' } }]]);
  expect((await shownNow(page)).active).toBe('pushed');
  expect(errors).toEqual([]);
});

/** The store's files from now on with a new validator; `rewrite` also changes the bytes of the file it names. */
function deployments(page) {
  const site = { etag: '"deployed-1"', rewrite: null };
  const served = page.context().route(STORE, async route => {
    const response = await route.fetch();
    const url = route.request().url();
    const body = site.rewrite?.test(url) ? Buffer.from((await response.body()).map(byte => byte ^ 0x5a)) : undefined;
    await route.fulfill({ response, headers: { ...response.headers(), etag: site.etag }, ...(body === undefined ? {} : { body }) });
  });
  return served.then(() => site);
}

test('a host that redeployed the store with the same bytes: nothing is said, and every read goes on', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = observeProductErrors(page);
  const site = await deployments(page);
  await openStore(page);
  await takeSteps(page, [['color.by', { field: PSEUDOTIME }]]);
  await switchTabAway(page);
  site.etag = '"deployed-2"';
  const before = await shownNow(page);

  // Every file has a new validator; the field read before is read again under it.
  await verifyFromMenu(page);
  await expect(notice(page, 'reproduced exactly (1 step)')).toBeVisible();
  await expect.poll(() => shownNow(page)).toEqual(before);
  await page.locator('#history-undo-btn').click();
  await expect.poll(async () => (await shownNow(page)).active).toBe('stage');
  await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
  await expect(page.locator('#notification-center .notification', { hasText: 'changed on the host' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a host that really rewrote the store: Verify says so in one sentence, what was shown stays, and nothing is mixed', async ({ page }) => {
  test.setTimeout(120_000);
  const site = await deployments(page);
  await openStore(page);
  // The opening's stage, shown again last, stays resident; pseudotime, colored by at step 1, is released.
  await takeSteps(page, [['color.by', { field: PSEUDOTIME }], ['color.by', { field: STAGE }]]);
  await switchTabAway(page);
  site.etag = '"deployed-2"';
  site.rewrite = PSEUDOTIME_VALUES;
  const before = await shownNow(page);

  await verifyFromMenu(page);
  const failed = notice(page, 'Verifying the branch failed');
  await expect(failed).toBeVisible();
  await expect(failed.locator('.notification-message')).toHaveText(/^Verifying the branch failed: "[^"]+" was not verified, because step 1 \("Colored by pseudotime"\) could not run: .*changed on the host.*open it again to read the new version\.$/);
  await expect(failed.locator('.notification-details')).toHaveCount(0);
  // Reading again in this session can never succeed, so no button offers it.
  const read = notice(page, 'Cellucid could not read field pseudotime');
  await expect(read).toContainText('changed on the host');
  await expect(read.locator('.notification-action')).toHaveCount(0);
  await expect.poll(() => shownNow(page)).toEqual(before);
  expect(await fieldFacts(page, 'pseudotime')).toEqual({ loaded: false, arrays: false });

  // The app stays usable: an undo that needs the unreadable field says why and moves nothing.
  await page.locator('#history-undo-btn').click();
  await expect(notice(page, 'Undo failed')).toContainText('changed on the host');
  await expect.poll(() => shownNow(page)).toEqual(before);
  // What needs no read goes on.
  await takeSteps(page, [['filter.category.visibility', { field: STAGE, categories: ['early'], visible: false }]]);
  expect((await shownNow(page)).shownCells).toBeLessThan(48);
});

test('a read that fails once: Verify gives no verdict, Try again is offered, and the next Verify reproduces', async ({ page }) => {
  test.setTimeout(120_000);
  await openStore(page);
  // The opening's stage, shown again last, stays resident; pseudotime, colored by at step 1, is released.
  await takeSteps(page, [['color.by', { field: PSEUDOTIME }], ['color.by', { field: STAGE }]]);
  await switchTabAway(page);
  const before = await shownNow(page);
  // A refusal, not a 404: an absent chunk of a Zarr store is its fill value.
  const failing = route => route.fulfill({ status: 403, body: 'refused' });
  await page.context().route(PSEUDOTIME_VALUES, failing);

  await verifyFromMenu(page);
  await expect(notice(page, 'was not verified')).toBeVisible();
  await expect(notice(page, 'Cellucid could not read field pseudotime').locator('.notification-action')).toHaveText('Try again');
  await expect.poll(() => shownNow(page)).toEqual(before);
  expect(await fieldFacts(page, 'pseudotime')).toEqual({ loaded: false, arrays: false });

  await page.context().unroute(PSEUDOTIME_VALUES, failing);
  await page.locator('#notification-center .notification').evaluateAll(cards => cards.forEach(card => card.remove()));
  await verifyFromMenu(page);
  await expect(notice(page, 'reproduced exactly (2 steps)')).toBeVisible();
  await expect.poll(() => shownNow(page)).toEqual(before);
});

test('a broken invariant is never said as a sentence, and never with a stack', async ({ page }) => {
  test.setTimeout(120_000);
  await openStore(page);
  // Verify replays the step that clears the coloring: there the invariant breaks.
  await takeSteps(page, [['color.by', { field: null }]]);
  const before = await shownNow(page);
  await page.evaluate(() => {
    const state = window._cellucidState;
    const own = state.clearActiveField;
    state.clearActiveField = function clearActiveField() {
      state.clearActiveField = own;
      throw new TypeError('Internal invariant of the visibility pass.');
    };
  });
  await verifyFromMenu(page);
  const failed = notice(page, 'Verifying the branch failed');
  await expect(failed.locator('.notification-message')).toHaveText('Verifying the branch failed: "Main" was not verified, because step 1 ("Cleared the coloring") could not run: a problem inside Cellucid stopped it; Details has its words for a bug report.');
  await expect(failed.locator('.notification-details-text')).toHaveText('Internal invariant of the visibility pass.');
  await expect.poll(() => shownNow(page)).toEqual(before);
});
