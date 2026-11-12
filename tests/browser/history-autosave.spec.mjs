/**
 * The history is kept in this browser as it is made (IndexedDB
 * `cellucid-history`, `app/history/autosave.js`): a page that crashes or is
 * closed loses nothing, and the same dataset opened again offers to continue
 * ("Continue where you left off?", Continue / Start fresh). Continue puts the
 * whole history back and keeps writing into it; Start fresh is not asked
 * again; named saves are listed beside it and stay as they were made.
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { continueOffer as offerCard, continueWhereLeftOff, dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-autosave-ci`;
const OFFER = /^Continue where you left off\? Kept in this browser from .* on this dataset: \d+ steps?\.$/;

function productErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/**
 * Open the dataset and wait for its history. No section is opened: opening
 * one is a step (`layout.section.open`), and a reopened page that took a step
 * of its own before Continue would rightly keep a saved state of its own.
 */
async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.current()?.active != null)).toBe(true);
}

function savedStates(page) {
  return page.evaluate(() => window._cellucidHistories.savedStates.list());
}

function activeField(page) {
  return page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null);
}

/** Color by `label` from the `select` of its kind and wait until the step is kept in this browser. */
async function colorAndKeep(page, select, label) {
  await page.locator(select).selectOption({ label });
  await expect.poll(() => activeField(page)).toBe(label);
  await page.evaluate(() => window._cellucidHistories.current().reconcile());
  await expect.poll(async () => (await savedStates(page)).find(state => state.current)?.steps ?? 0).toBeGreaterThan(0);
}

test('every step is written as it is made, so a closed page loses nothing: reopened, Continue puts the history back and keeps writing into it', async ({ page, context }) => {
  const errors = productErrors(page);
  await openDataset(page);
  // It opens colored by cell_type (its first coloring, part of the opening): score is the step.
  await expect.poll(() => activeField(page)).toBe('cell_type');
  await colorAndKeep(page, '#continuous-field', 'score');
  const [kept] = await savedStates(page);
  const steps = await page.evaluate(() => window._cellucidHistories.current().active.steps.size);

  // The tab goes (its step was written before: nothing is left to write on the way out).
  const crashed = await context.newPage();
  await closePageWithApplicationRetirement(page);
  const errorsAfter = productErrors(crashed);
  await openDataset(crashed);
  await expect(offerCard(crashed)).toBeVisible();
  await expect(offerCard(crashed).locator('.notification-message')).toHaveText(OFFER);
  expect(await activeField(crashed)).toBe('cell_type');
  await continueWhereLeftOff(crashed);
  await expect.poll(() => activeField(crashed), { timeout: 60_000 }).toBe('score');
  // The field is back as the head's values are restored, before the loaded history
  // takes the place of the one that opened (`history.js` `load`): the step made
  // those values, and it is its record that is waited for.
  await expect.poll(() => crashed.evaluate(() => window._cellucidHistories.current().active.steps.size)).toBe(steps);
  // It keeps writing into the same saved state: colored by the categorical field again now.
  await crashed.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect.poll(() => activeField(crashed)).toBe('cell_type');
  await crashed.evaluate(() => window._cellucidHistories.current().reconcile());
  await expect.poll(async () => (await savedStates(crashed)).find(state => state.id === kept.id)?.steps).toBe(kept.steps + 1);
  expect((await savedStates(crashed)).filter(state => state.kind === 'autosave').map(state => state.id)).toEqual([kept.id]);
  expect([...errors, ...errorsAfter]).toEqual([]);
});

test('Start fresh is not asked again; a named save is listed beside the autosave and stays as it was made', async ({ page }) => {
  const errors = productErrors(page);
  await openDataset(page);
  // It opens colored by cell_type (its first coloring): score is the step.
  await colorAndKeep(page, '#continuous-field', 'score');
  await page.evaluate(() => window._cellucidHistories.savedStates.saveAs('Colored by score'));
  await openDataset(page);
  await expect(offerCard(page)).toBeVisible();
  await offerCard(page).getByRole('button', { name: 'Start fresh' }).click();
  await expect(offerCard(page)).toHaveCount(0);
  await openDataset(page);
  // Nothing is left to offer for this dataset (the offer a page makes is this decision).
  expect(await page.evaluate(() => window._cellucidHistories.currentAutosave().offerContinue({
    notifications: { show() { throw new Error('offered again'); } }, onContinue() {},
  }))).toBeNull();
  await expect(offerCard(page)).toHaveCount(0);
  const states = await savedStates(page);
  expect(states.map(state => [state.kind, state.name]).sort()).toEqual([['autosave', null], ['named', 'Colored by score']]);
  // The named save opens to what it was.
  const named = states.find(state => state.kind === 'named');
  // It opened, with nothing to say (`{opened, problem, code}`: a refusal would name why).
  expect(await page.evaluate(id => window._cellucidHistories.savedStates.open(id), named.id)).toMatchObject({ opened: true, problem: null });
  await expect.poll(() => activeField(page)).toBe('score');
  expect(errors).toEqual([]);
});
