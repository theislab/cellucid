/**
 * Connectivity edges kept on while other cells of the dataset are opened:
 * a share, a smaller share, every cell again. Each opening ends with
 * the edges still on, drawn among the cells open now, and no failure; and the
 * history steps back through them.
 */
import { expect, test } from './helpers/test.mjs';
import { encodedAppUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForPageAtRest, whenActionsDone } from './helpers/dataset-ready.mjs';

const START_URL =
  `/?sampleCatalog=${encodedAppUrl('/tests/browser/fixtures/demo-catalog/')}`
  + '&dataset=synthetic-cell-types-2d&acceptance=connectivity-open-cells';

async function dispatch(page, type, params) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      return { outcome: (await getActions().dispatch(actionType, actionParams)).outcome };
    } catch (error) {
      return { error: error.message };
    }
  }, [type, params]);
}

const edgesState = page => page.evaluate(() => ({
  on: document.getElementById('toggle-connectivity').checked,
  info: document.getElementById('connectivity-info').textContent,
  preference: document.getElementById('connectivity-limit').dataset.sessionPreference,
}));

test('edges stay on and follow the cells open through a share, a smaller share and every cell', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await whenActionsDone(page);
  await waitForPageAtRest(page);

  expect(await dispatch(page, 'setting.set', { setting: 'toggle-connectivity', value: true })).not.toHaveProperty('error');
  await waitForPageAtRest(page);
  // The person's Max edges stays through every opening (a preference).
  expect(await dispatch(page, 'setting.set', { setting: 'connectivity-limit', value: 1000 })).not.toHaveProperty('error');
  await waitForPageAtRest(page);
  const whole = await edgesState(page);
  expect(whole.on).toBe(true);
  expect(whole.preference).toBe('1000');

  for (const params of [{ mode: 'subsample', fraction: 0.5 }, { mode: 'subsample', fraction: 0.25 }, { mode: 'all' }]) {
    const opened = await dispatch(page, 'cells.open', params);
    expect(opened, `${JSON.stringify(params)}\n${errors.join("\n")}`).not.toHaveProperty("error");
    await waitForPageAtRest(page);
    const state = await edgesState(page);
    expect(state.on, `edges still on after ${JSON.stringify(params)}`).toBe(true);
    expect(state.info).toMatch(/total · .* visible · .* shown/);
    expect(state.info, 'edges are drawn among the cells open now').not.toMatch(/· 0 shown/);
    expect(state.preference, `Max edges after ${JSON.stringify(params)}`).toBe('1000');
  }
  // Back through the openings: each undo puts the cells and the edges back.
  for (let step = 0; step < 3; step++) {
    expect(await dispatch(page, 'history.undo', {})).not.toHaveProperty('error');
    await waitForPageAtRest(page);
    expect((await edgesState(page)).on).toBe(true);
  }
  expect(errors).toEqual([]);
});
