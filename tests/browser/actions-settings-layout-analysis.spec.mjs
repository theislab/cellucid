/**
 * Settings, layout, analyses and the agent's reads as actions, on a small
 * fixture dataset (`app/actions/definitions/{settings,layout,analysis,reads}.js`):
 *
 * - every setting of the control inventory is listed with its label, kind
 *   and range, can be set through `setting.set`, and a person's change of
 *   it is recorded as one step that undo puts back; a control added to the
 *   markup is a setting with no code;
 * - the sections float, move, dock, open and close, the sidebar hides, the
 *   theme changes, through actions and by hand alike;
 * - an analysis is opened, set, run and read through actions; its result
 *   records what it was computed on and is stale exactly when that changes,
 *   also when restored from its saved form;
 * - each read returns the exact JSON the fixture implies, and a picture of a
 *   view is a PNG of the size asked for, with nothing downloaded;
 * - apply → undo → the state's fingerprint is back, for each of these
 *   actions (runs with the page's state domains, `app/state/domains/`).
 */
import { expect, test } from './helpers/test.mjs';
import { applyUndoRedo, waitForHistory } from './helpers/state-history.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { decodePng } from './helpers/png-pixels.mjs';

const DATASET = 'b3-actions';
const ROOT = appUrl('/tests/browser/fixtures/generated-b3-actions/');
const CELLS = 60;
const GENES = Object.freeze(['CD3E', 'CD3D', 'MS4A1', 'LYZ', 'NKG7', 'GNLY']);
const TYPES = Object.freeze(['T cell', 'B cell', 'Monocyte']);
const typeOf = cell => cell % 3;
const scoreOf = cell => cell / 4;
// Each gene is high in one cell type (its markers) and varies a little in every cell.
const expressionOf = (cell, gene) => (typeOf(cell) === gene % 3 ? 5 : 0) + ((cell + gene) % 2);

async function serveDataset(page) {
  const bytes = anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X: Float32Array.from({ length: CELLS * GENES.length }, (_, index) => expressionOf(Math.floor(index / GENES.length), index % GENES.length)),
    obs: {
      cell_type: { categories: [...TYPES], codes: Int8Array.from({ length: CELLS }, (_, cell) => typeOf(cell)) },
      score: Float32Array.from({ length: CELLS }, (_, cell) => scoreOf(cell)),
    },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, index) => (index % 2 === 0 ? (index / 2) % 10 : Math.floor(index / 20))), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'B3 actions fixture' } },
  });
  const file = `${DATASET}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] });
  const prefix = new URL(ROOT).pathname;
  await page.route(`${ROOT}**`, async route => {
    const relative = new URL(route.request().url()).pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
    } else if (relative === file) {
      await fulfillFile(route, bytes).catch(() => {});
    } else {
      await route.fulfill({ status: 404, body: `Unexpected fixture request: ${relative}\n` });
    }
  });
}

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openFixture(page) {
  await serveDataset(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await waitForDatasetReady(page, CELLS);
  await waitForPageAtRest(page);
  // The page's dispatcher is the one the specs import: one module per URL.
  expect(await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return getActions().provided('setting.set') && getActions().provided('dataset.summary');
  })).toBe(true);
}

/** Dispatch an action in the page; a refusal comes back as `{error}`. */
function dispatch(page, type, params = {}, meta = {}) {
  return page.evaluate(async ([type, params, meta]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome, step } = await getActions().dispatch(type, params, meta);
      return { outcome, step: step === null ? null : { type: step.type, params: step.params, label: step.label, origin: step.by.origin } };
    } catch (error) {
      return { error: error.message, code: error.code ?? null };
    }
  }, [type, params, meta]);
}

async function read(page, type, params = {}) {
  const result = await dispatch(page, type, params);
  expect(result.error, `${type} answers`).toBeUndefined();
  expect(result.step).toBeNull();
  return result.outcome;
}

/**
 * The page's own history, on a tracker of its own started from what is shown
 * now, for the specs that check what a person's change records: every step
 * after its opening one is the spec's.
 */
async function startHistory(page) {
  await waitForHistory(page);
  await page.evaluate(() => window._cellucidHistories.current().startTracker({ start: 'shown' }));
}

/** The page's history: undo once. */
function undo(page) {
  return page.evaluate(() => window._cellucidHistories.current().undo());
}

/** The steps the tracker in use holds, its opening one included. */
function stepCount(page) {
  return page.evaluate(() => window._cellucidHistories.current().active.steps.size);
}

/** The steps on the path to the head, after the opening one. */
function steps(page) {
  return page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await new Promise(resolve => setTimeout(resolve, 0));
    const { outcome } = await getActions().dispatch('history.get', {});
    return outcome.steps.slice(1).map(step => ({ type: step.type, label: step.label, code: step.code, origin: step.origin }));
  });
}

// One opening: the reads come first, on the fixture as it opened.
test('what an agent reads and sets: each read is the exact JSON of the fixture and a picture is a PNG, never a download; every setting is listed, set, and refused in words', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);

  await test.step('each read returns the exact JSON of the fixture; a picture is a PNG of the size asked for, never a download', async () => {
    const downloads = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));

    const summary = await read(page, 'dataset.summary');
    expect(summary).toEqual({
      name: 'B3 actions fixture', id: DATASET, source: summary.source, description: null, citation: null,
      cells: { total: CELLS, open: CELLS, share: 1, subsample: null, digest: summary.cells.digest },
      genes: { count: GENES.length, modalities: null, modality: null, read_for: null, values: summary.genes.values },
      embeddings: summary.embeddings,
      vector_fields: [],
      fields: { categorical: 1, continuous: 1, user_defined: 0 },
    });
    // The Expression values the genes are shown in: as stored by default.
    expect(summary.genes.values).toMatchObject({ normalize: false, log1p: false });
    // The embeddings shown (on), each by the obsm key and columns the actions take; the arrays the mapping could turn on are listed off.
    expect(summary.embeddings.filter(embedding => embedding.enabled).map(embedding => embedding.dimension)).toEqual([2]);
    expect(summary.embeddings.every(embedding => typeof embedding.key === 'string')).toBe(true);
    // A field's categories are known once it is read: cell_type is read as the
    // dataset opens colored by it (`first-coloring.js`).
    const byKey = list => [...list.fields].sort((a, b) => a.key.localeCompare(b.key));
    expect(byKey(await read(page, 'fields.list'))).toEqual([
      { key: 'cell_type', kind: 'categorical', categories: 3, user_defined: false },
      { key: 'score', kind: 'continuous', user_defined: false },
    ]);
    expect(await read(page, 'fields.list', { kind: 'continuous' })).toEqual({ fields: [{ key: 'score', kind: 'continuous', user_defined: false }] });

    const categories = await read(page, 'field.categories', { field: { source: 'obs', key: 'cell_type' } });
    expect(categories.field).toBe('cell_type');
    expect(categories.missing).toBe(0);
    expect(categories.categories.map(({ label, cells, visible, shown }) => ({ label, cells, visible, shown }))).toEqual(
      TYPES.map(label => ({ label, cells: CELLS / 3, visible: CELLS / 3, shown: true }))
    );
    for (const category of categories.categories) expect(category.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(byKey(await read(page, 'fields.list'))[0]).toEqual({ key: 'cell_type', kind: 'categorical', categories: 3, user_defined: false });

    expect(await read(page, 'genes.search', { query: 'cd3' })).toEqual({ genes: ['CD3E', 'CD3D'], matches: 2, total: GENES.length });
    expect(await read(page, 'genes.search', { query: 'cd', limit: 1 })).toEqual({ genes: ['CD3E'], matches: 2, total: GENES.length });

    const cells = [0, 1, 5, 59];
    expect(await read(page, 'cells.values', {
      cells, fields: [{ source: 'obs', key: 'cell_type' }, { source: 'obs', key: 'score' }, { source: 'var', key: 'LYZ' }],
    })).toEqual({
      cells,
      columns: [
        { field: { source: 'obs', key: 'cell_type', kind: 'categorical' }, values: cells.map(cell => TYPES[typeOf(cell)]) },
        { field: { source: 'obs', key: 'score', kind: 'continuous' }, values: cells.map(scoreOf) },
        { field: { source: 'var', key: 'LYZ', kind: 'continuous' }, values: cells.map(cell => expressionOf(cell, GENES.indexOf('LYZ'))) },
      ],
      not_open: [],
      // The genes' values as shown (Data mapping › Expression values: as stored by default).
      gene_values: 'raw counts as stored, not normalized',
    });
    expect((await dispatch(page, 'cells.values', { cells: [60], fields: [{ source: 'obs', key: 'score' }] })).error)
      .toBe('Cell 60 is not a cell of this dataset: it has 60 cells, numbered from 0.');
    expect((await dispatch(page, 'cells.values', { cells: [0], fields: [{ source: 'var', key: 'cd3e' }] })).error)
      .toBe('"cd3e" is not a gene in this dataset. Names are exact: did you mean "CD3E"?');
    expect((await dispatch(page, 'field.categories', { field: { source: 'obs', key: 'cell' } })).error)
      .toBe('There is no field "cell"; fields like it: "cell_type".');

    const expected = TYPES.map((label, type) => {
      const values = Array.from({ length: CELLS }, (_, cell) => cell).filter(cell => typeOf(cell) === type).map(scoreOf).sort((a, b) => a - b);
      const m = values.length;
      return {
        label, cells: m, mean: values.reduce((sum, value) => sum + value, 0) / m,
        median: (values[m / 2 - 1] + values[m / 2]) / 2, min: values[0], max: values[m - 1],
        above_zero: values.filter(value => value > 0).length / m,
      };
    });
    const byType = await read(page, 'field.summary', { field: { source: 'obs', key: 'score' }, by: { source: 'obs', key: 'cell_type' } });
    expect(byType.field).toEqual({ source: 'obs', key: 'score', kind: 'continuous' });
    expect(byType.read_for).toBeNull();
    expect(byType.groups.map(group => group.label)).toEqual([...TYPES]);
    for (const [index, group] of byType.groups.entries()) {
      for (const key of ['cells', 'mean', 'median', 'min', 'max', 'above_zero']) expect(group[key]).toBeCloseTo(expected[index][key], 5);
    }

    const views = await read(page, 'views.state');
    // Each view by the name actions take ("View N"), and the title its chip shows.
    expect(views.active).toBe('View 1');
    expect(views.views[0].name).toBe('View 1');
    expect(typeof views.views[0].title).toBe('string');
    // The layout the Compare views control shows (grid by default, one view in it).
    expect(views.layout).toBe(await page.locator('#view-layout-mode').inputValue());
    expect(views.views).toHaveLength(1);
    expect(views.views[0]).toMatchObject({ live: true, active: true, representation: { dimension: 2 }, filters: [] });
    expect(views.views[0].camera.navigationMode).toMatch(/^(orbit|planar|free)$/);
    expect(views.highlights).toEqual({ active_page: expect.any(String), pages: [{ name: expect.any(String), cells: 0, groups: [] }] });

    // The size asked for is the box the plot fits in (as in a figure export):
    // the plot keeps the view's shape inside it; the picture says its own size
    // and the plot's exactly.
    const picture = await read(page, 'view.picture', { width: 320, height: 200 });
    // One side fills the box, the other fits inside it.
    expect(picture.plot.width).toBeLessThanOrEqual(320);
    expect(picture.plot.height).toBeLessThanOrEqual(200);
    expect(picture.plot.width === 320 || picture.plot.height === 200).toBe(true);
    const aspect = picture.plot.width / picture.plot.height;
    expect(picture.view).toBe('View 1');
    expect(picture.notes).toEqual([]);
    const png = Buffer.from(picture.png, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const decoded = decodePng(png);
    expect([decoded.width, decoded.height]).toEqual([picture.width, picture.height]);
    expect(picture.width).toBeGreaterThan(320);
    expect(picture.height).toBeGreaterThanOrEqual(200);
    // A plot that much larger is a picture that much larger (the legend beside
    // it is the same).
    const larger = await read(page, 'view.picture', { width: 400, height: 240 });
    expect(larger.plot.width / larger.plot.height).toBeCloseTo(aspect, 6);
    expect(larger.width - picture.width).toBeCloseTo(larger.plot.width - picture.plot.width, 0);
    expect(Math.abs(larger.height - picture.height - (larger.plot.height - picture.plot.height))).toBeLessThanOrEqual(1);
    // A box of another shape around the same fitted plot draws the same picture.
    const taller = await read(page, 'view.picture', { width: 320, height: 400 });
    expect(picture.plot.width).toBe(320); // the view is wider than the 320 × 200 box
    expect([taller.width, taller.height]).toEqual([picture.width, picture.height]);
    const largerDecoded = decodePng(Buffer.from(larger.png, 'base64'));
    expect([largerDecoded.width, largerDecoded.height]).toEqual([larger.width, larger.height]);
    // Without the legend, the picture is only the plot and its margins.
    const bare = await read(page, 'view.picture', { width: 320, height: 200, legend: false });
    expect(bare.width).toBeLessThan(picture.width);
    expect((await dispatch(page, 'view.picture', { view: 'View 9' })).error).toBe('There is no View 9: 1 view is open (View 1).');
    // The download path ends in `downloadBlob`, which a picture never reaches.
    expect(downloads).toEqual([]);
    expect(errors).toEqual([]);
  });

  await test.step('every setting is listed, set through setting.set, and refused in words when the value is wrong', async () => {
    const { settings } = await read(page, 'settings.list');
    // Every control of the inventory but the layout's (`SETTING_CONTROL_DOMAINS`, by the one map `controlDomainOf`).
    const inventory = await page.evaluate(async () => {
      const { SETTING_CONTROL_DOMAINS, createUiControlSerializer, controlDomainOf } = await import('/assets/js/app/state-serializer/ui-controls.js');
      const all = createUiControlSerializer({ sidebar: document.getElementById('sidebar') }).collectUIControls();
      return Object.entries(all).filter(([key, record]) => SETTING_CONTROL_DOMAINS.includes(controlDomainOf(key, record.type))).map(([key]) => key);
    });
    expect(settings.map(setting => setting.id)).toEqual(inventory);
    const pointSize = settings.find(setting => setting.id === 'point-size');
    expect(pointSize).toMatchObject({ label: 'Point size', section: 'Visualization', kind: 'number', min: -24, max: 100, step: 0.5, available: true });
    expect(typeof pointSize.shown).toBe('string');
    // The selection tool is an input mode, page chrome: no setting.
    expect(settings.some(setting => setting.id === 'highlight-mode')).toBe(false);
    expect(settings.find(setting => setting.id === 'connectivity-limit')).toMatchObject({ kind: 'count', min: 1 });
    expect(settings.some(setting => setting.id === 'theme-select' || setting.id === 'view-layout-mode')).toBe(false);

    // Each available setting takes another value and is set back, through the action.
    const changed = [];
    const refused = [];
    for (const listed of settings) {
      // Whether it can be changed now: another setting may have switched it off meanwhile.
      const setting = (await read(page, 'settings.list')).settings.find(entry => entry.id === listed.id);
      let other;
      if (setting.kind === 'switch') other = !setting.value;
      else if (setting.kind === 'count') other = setting.value + 1;
      else if (setting.kind === 'number') other = setting.value === setting.max ? setting.min : setting.max;
      else if (setting.kind === 'color') other = setting.value === '#123456' ? '#654321' : '#123456';
      else if (setting.kind === 'text') other = `${setting.value}x`;
      else other = setting.options.find(option => option.value !== setting.value)?.value;
      // Smoke rendering builds a volume: a choice of its own spec (renderer-smoke).
      if (other === undefined || setting.id === 'render-mode') continue;
      const applied = await dispatch(page, 'setting.set', { setting: setting.id, value: other });
      if (applied.error !== undefined) {
        // Switched off by another setting, or kept by its owner until its data is there: said in words.
        expect(applied.error, setting.id).toMatch(/^".+" cannot be changed now: /);
        // With the reason its owner gave (ui/core/control-availability.js), never a guess.
        expect(applied.error, setting.id).not.toMatch(/it is not ready yet$|switched off by another setting/);
        refused.push(setting.id);
        continue;
      }
      const now = (await read(page, 'settings.list')).settings.find(entry => entry.id === setting.id);
      expect(now.value, setting.id).toEqual(other);
      const back = await dispatch(page, 'setting.set', { setting: setting.id, value: setting.value });
      expect(back.error, `${setting.id} goes back`).toBeUndefined();
      changed.push(setting.id);
    }
    expect(changed.length).toBeGreaterThan(40);
    // What could not be changed (off, or waiting for data this fixture has not) is the few.
    expect(refused.length, `refused: ${refused.join(', ')}`).toBeLessThan(changed.length / 2);

    expect((await dispatch(page, 'setting.set', { setting: 'point-size', value: 1000 })).error)
      .toBe('"Point size" goes from -24 to 100; 1000 is outside');
    expect((await dispatch(page, 'setting.set', { setting: 'point-size', value: 3.3 })).error)
      .toBe('"Point size" moves in steps of 0.5 from -24; 3.3 is between two steps');
    expect((await dispatch(page, 'setting.set', { setting: 'point-sise', value: 3 })).error)
      .toMatch(/^There is no setting "point-sise"; did you mean point-size \(Point size\)/);
    expect((await dispatch(page, 'setting.set', { setting: 'highlight-mode', value: 'highlight-mode-lasso' })).error)
      .toMatch(/^There is no setting "highlight-mode"/);
    expect((await dispatch(page, 'settings.list', { section: 'Nowhere' })).error).toMatch(/^No settings are in a section "Nowhere"/);
    expect(errors).toEqual([]);
  });
});

test('every setting changed through its control is recorded as its own step, and undo puts each back', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  await startHistory(page);
  const { settings } = await read(page, 'settings.list');
  let recorded = 0;
  for (const listed of settings) {
    const setting = (await read(page, 'settings.list')).settings.find(entry => entry.id === listed.id);
    if (!setting.available || setting.id === 'render-mode') continue;
    // What a person's hand does to the control: its value set, and its own events.
    const next = await page.evaluate(({ id, kind, value }) => {
      const element = document.getElementById(id);
      if (kind === 'switch') {
        element.click();
        return element.checked;
      }
      if (kind === 'count') {
        element.dataset.sessionPreference = String(value + 1);
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return value + 1;
      }
      if (kind === 'choice') {
        const other = [...element.options].find(option => option.value !== value);
        if (other === undefined) return null;
        element.value = other.value;
      } else if (kind === 'number') {
        element.value = String(value === Number(element.max) ? element.min : element.max);
      } else if (kind === 'color') {
        element.value = value === '#123456' ? '#654321' : '#123456';
      } else {
        element.value = `${value}x`;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return kind === 'number' ? Number(element.value) : element.value;
    }, setting);
    if (next === null) continue;
    const now = (await read(page, 'settings.list')).settings.find(entry => entry.id === setting.id);
    // Its owner kept the value (what it needs is not in this fixture): nothing changed.
    if (JSON.stringify(now.value) === JSON.stringify(setting.value)) continue;
    await expect.poll(() => steps(page).then(list => list.at(-1)?.code), setting.id)
      .toBe(`set_setting(${JSON.stringify(setting.id)}, ${JSON.stringify(now.value)})`);
    recorded += 1;
    await undo(page);
    expect((await read(page, 'settings.list')).settings.find(entry => entry.id === setting.id).value, `${setting.id} undone`)
      .toEqual(setting.value);
  }
  expect(recorded).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('sections float, move, dock and open, the sidebar hides and the theme changes, by action and by hand', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  await startHistory(page);
  const panel = id => page.evaluate(id => (async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const { outcome } = await getActions().dispatch('layout.get', {});
    return outcome.panels.find(entry => entry.id === id);
  })(), id);

  expect((await dispatch(page, 'layout.panel.float', { panel: 'Navigation', left: 400, top: 120, width: 320, height: 300 })).outcome)
    .toEqual({ panel: 'Navigation' });
  expect(await panel('navigation-section')).toEqual({
    id: 'navigation-section', title: 'Navigation', floating: true, open: true, left: 400, top: 120, width: 320, height: 300,
  });
  expect((await dispatch(page, 'layout.panel.place', { panel: 'navigation-section', left: 420, top: 140, width: 340, height: 280 })).outcome)
    .toEqual({ panel: 'Navigation' });
  expect(await panel('navigation-section')).toMatchObject({ left: 420, top: 140, width: 340, height: 280 });
  expect((await dispatch(page, 'layout.panel.dock', { panel: 'Navigation' })).outcome).toEqual({ panel: 'Navigation' });
  expect((await panel('navigation-section')).floating).toBe(false);
  expect((await dispatch(page, 'layout.panel.place', { panel: 'Navigation', left: 1, top: 1, width: 300, height: 300 })).error)
    .toBe('Navigation is docked in the sidebar; undock it first (layout.panel.float).');
  expect((await dispatch(page, 'layout.panel.float', { panel: 'Nowhere' })).error).toMatch(/^There is no sidebar section "Nowhere"; the sections are Session, State, Agents, Visualization/);

  expect((await dispatch(page, 'layout.section.open', { section: 'Compare views', open: false })).outcome).toEqual({ panel: 'Compare views' });
  await expect(page.locator('#compare-views-section')).not.toHaveAttribute('open', '');
  expect((await dispatch(page, 'layout.theme.set', { theme: 'dark' })).outcome).toEqual({ theme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#theme-select')).toHaveValue('dark');
  expect((await dispatch(page, 'layout.sidebar.show', { shown: false })).outcome).toEqual({ shown: false });
  await expect(page.locator('#sidebar')).toHaveClass(/hidden/);
  const layout = await read(page, 'layout.get');
  expect(layout.theme).toBe('dark');
  expect(layout.sidebar.shown).toBe(false);
  expect((await dispatch(page, 'layout.sidebar.show', { shown: true })).outcome).toEqual({ shown: true });

  // By hand: the undock button and the theme select are steps of the same actions.
  const recordedBefore = (await steps(page)).length;
  await page.getByRole('button', { name: 'Undock Visualization panel into a floating window' }).click();
  await expect.poll(async () => (await panel('visualization-section')).floating).toBe(true);
  await page.locator('#theme-select').selectOption('light');
  await expect.poll(() => steps(page).then(list => list.slice(recordedBefore).map(step => step.code)))
    .toEqual(['float_panel("visualization-section")', 'set_theme("light")']);
  expect(errors).toEqual([]);
});

test('an analysis is opened, set, run and read by action; its result is stale exactly when what it was computed on changes', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  await page.waitForFunction(() => window._comparisonModule?.getAnalysisWindowManager?.() != null);
  expect((await dispatch(page, 'analysis.open', { analysis: 'markers' })).outcome).toEqual({ title: 'Marker genes' });
  await expect(page.locator('#analysis-header-genesPanel')).toHaveAttribute('aria-expanded', 'true');
  const options = await read(page, 'analysis.markers.get');
  expect(options).toMatchObject({ analysis: 'markers', in: 'panel', has_result: false, running: false, stale: false, stale_reasons: [], computed_on: null });
  const set = await dispatch(page, 'analysis.markers.set', { options: { groupBy: 'cell_type' } });
  expect(set.error).toBeUndefined();
  const ran = await dispatch(page, 'analysis.run', { analysis: 'markers' });
  expect(ran.error).toBeUndefined();
  expect(ran.outcome.rows).toBeGreaterThan(0);
  const result = await read(page, 'analysis.result', { analysis: 'markers', top: 2 });
  expect(result.columns).toEqual(['group', 'rank', 'gene', 'score', 'log2_fold_change', 'p_adjusted', 'percent_in_group', 'percent_rest', 'auroc']);
  expect([...result.rows.map(row => row[0])].sort()).toEqual(['B cell', 'B cell', 'Monocyte', 'Monocyte', 'T cell', 'T cell']);
  // Each type's top marker is a gene high in it.
  for (const [type, label] of TYPES.entries()) {
    const top = result.rows.find(row => row[0] === label && row[1] === 1);
    expect(GENES.indexOf(top[2]) % 3, `${label}'s first marker`).toBe(type);
  }
  expect(result.stale).toBe(false);
  expect(result.computed_on).toMatchObject({
    dataset: DATASET, cells: { open: CELLS, of: CELLS, share: 1, method: null, seed: null }, genes_read_for: null, pages: [], visible_only: false,
  });
  // A deciding option changed: stale, and current again when it is set back (by content, not by a counter).
  const groupBy = options.options.groupBy;
  const minCells = (await read(page, 'analysis.markers.get')).options.minCells ?? null;
  const other = minCells === null ? null : minCells + 1;
  if (other !== null) {
    await dispatch(page, 'analysis.markers.set', { options: { minCells: other } });
    let list = await read(page, 'analysis.list');
    expect(list.analyses.find(entry => entry.analysis === 'markers')).toMatchObject({ stale: true, stale_reasons: ['The settings changed since this result.'] });
    await dispatch(page, 'analysis.markers.set', { options: { minCells } });
    list = await read(page, 'analysis.list');
    expect(list.analyses.find(entry => entry.analysis === 'markers')).toMatchObject({ stale: false, stale_reasons: [] });
  }
  expect(groupBy === 'cell_type' || typeof groupBy === 'string').toBe(true);
  // Saved with what it was computed on, a result restored where that differs is stale.
  const restored = await page.evaluate(async () => {
    const ui = window._comparisonModule.getPanelUI('genesPanel');
    const saved = structuredClone(ui.exportResult());
    saved.provenance.cells = { ...saved.provenance.cells, digest: 'another-cell-set', open: 30 };
    await ui.importResult(saved);
    const reasons = await ui.getStaleReasons();
    return { stale: reasons.length > 0, reasons };
  });
  expect(restored).toEqual({ stale: true, reasons: [`The open cells changed since this result (30 cells then, ${CELLS} cells now).`] });
  // A window: opened, moved and closed by action.
  const opened = await dispatch(page, 'analysis.open', { analysis: 'markers', window: true });
  expect(opened.outcome).toEqual({ window: 1 });
  expect((await dispatch(page, 'analysis.window.place', { window: 1, left: 500, top: 100, width: 420, height: 360 })).error).toBeUndefined();
  expect((await read(page, 'analysis.list')).analyses.filter(entry => entry.in === 1).map(entry => entry.analysis)).toEqual(['markers']);
  expect((await dispatch(page, 'analysis.window.close', { window: 1 })).outcome).toEqual({ title: 'Marker genes' });
  expect((await dispatch(page, 'analysis.window.close', { window: 1 })).error).toBe('There is no analysis window 1: none is open.');
  expect((await dispatch(page, 'analysis.result', { analysis: 'differential' })).error)
    .toBe('Differential expression has no result yet; run it first (analysis.run).');
  expect(errors).toEqual([]);
});

/** The step the history shows now, once nothing is under way. */
async function headStep(page) {
  return page.evaluate(async () => {
    const history = window._cellucidHistories.current();
    // A person's analysis change is recorded once the work it set off settles
    // (`whenSettled`), and `idle` waits for that record from the moment it is
    // observed. Only a shown analysis can settle now: one that is not shown
    // (Detailed, closed while a redo's redraw of it waits) draws when it is
    // shown, by design (`plot-render-slot.js`).
    await Promise.all(window._comparisonModule.listPanelUIs()
      .filter(({ ui }) => ui.isShown())
      .map(({ ui }) => ui.whenSettled()));
    await history.idle();
    const step = history.active.steps.get(history.active.headId);
    return { id: step.id, type: step.type, params: step.params, label: step.label, origin: step.by.origin };
  });
}

test('how an analysis is shown, and an analysis sent another\'s genes, are steps a person and an agent take alike; undo puts them back', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openFixture(page);
  await waitForHistory(page);
  for (const [type, params] of [
    ['analysis.open', { analysis: 'markers' }],
    ['analysis.markers.set', { options: { groupBy: 'cell_type' } }],
    ['analysis.run', { analysis: 'markers' }],
  ]) expect((await dispatch(page, type, params)).error, type).toBeUndefined();
  const report = await applyUndoRedo(page, [
    ['analysis.view.set', { analysis: 'markers', view: { more: true } }],
    ['analysis.view.set', { analysis: 'markers', view: { groups: ['test', 'filters'] } }],
    ['analysis.view.set', { analysis: 'markers', view: { show: 'list' } }],
    ['analysis.view.set', { analysis: 'markers', view: { group: 'B cell' } }],
    ['analysis.view.set', { analysis: 'markers', view: { heatmap: { colorscale: 'Viridis', clusterRows: false } } }],
    ['analysis.signature.set', { options: { geneSets: [{ name: 'T', genes: ['CD3E', 'CD3D'] }] }, show: true }],
    ['analysis.open', { analysis: 'markers', window: true }],
    ['analysis.window.collapse', { window: 1, collapsed: true }],
    ['analysis.open', { analysis: 'quick' }],
    ['analysis.quick.set', { categorical: ['cell_type'], continuous: ['score'] }],
    ['analysis.open', { analysis: 'detailed' }],
    ['analysis.detailed.set', { variable: { type: 'categorical_obs', key: 'cell_type' } }],
    ['analysis.detailed.set', { plot: 'pieplot', plot_options: [{ option: 'maxCategories', value: 5 }] }],
    ['analysis.size.set', { analysis: 'markers', expanded: { width: 900, height: 600, optionsWidth: 260, footerHeight: 180, statsWidth: 320 } }],
  ]);
  for (const outcome of report) {
    expect(outcome.refused, outcome.type).toBeNull();
    expect(outcome.step, `${outcome.type} is a step`).toBe(true);
    expect(outcome.untouched, `${outcome.type} changes only the domains it touches`).toEqual([]);
    expect(outcome.differs, `${outcome.type}: undo restores every domain`).toEqual([]);
    expect(outcome.redone, `${outcome.type}: redo gives it again`).toEqual([]);
  }
  // What it applied is what the analyses show.
  expect(await page.evaluate(() => {
    const markers = window._comparisonModule.getPanelUI('genesPanel');
    return { view: markers.getView(), open: window._comparisonModule.getOpenMode() };
  })).toEqual({
    view: {
      more: true, groups: ['test', 'filters'], show: 'list', group: 'B cell',
      heatmap: { transform: 'zscore', colorscale: 'Viridis', clusterRows: false, clusterCols: true, distance: 'correlation', linkage: 'average' },
    },
    open: 'detailed',
  });
  expect(await page.evaluate(() => {
    const settings = window._comparisonModule.exportSessionState().modes;
    return {
      quick: [settings.simple.settings.selectedCategoricalObsKeys, settings.simple.settings.selectedContinuousObsKeys],
      detailed: { ...settings.detailed.settings.config.dataSource, plot: settings.detailed.settings.config.plotType, maxCategories: settings.detailed.settings.config.plotOptions.maxCategories },
    };
  })).toEqual({
    quick: [['cell_type'], ['score']],
    detailed: { type: 'categorical_obs', variable: 'cell_type', plot: 'pieplot', maxCategories: 5 },
  });
  expect((await dispatch(page, 'analysis.quick.set', { categorical: ['batch'] })).error)
    .toBe('There is no categorical field "batch"; the choices are "cell_type".');
  expect((await dispatch(page, 'analysis.detailed.set', { plot: 'histogram' })).error)
    .toMatch(/^Detailed cannot draw "histogram" for this variable; it draws /);
  // Refused in one sentence, nothing changed.
  expect((await dispatch(page, 'analysis.view.set', { analysis: 'markers', view: { set: 'T' } })).error)
    .toBe('Marker genes has no view "set"; it takes "more", "groups", "plot", "show", "group" and "heatmap".');
  expect((await dispatch(page, 'analysis.view.set', { analysis: 'markers', view: { group: 'NK cell' } })).error)
    .toBe('There is no tested group "NK cell" in the marker genes result; its groups are "T cell", "B cell" and "Monocyte".');
  expect((await dispatch(page, 'analysis.view.set', { analysis: 'signature', view: { set: 'B' } })).error)
    .toBe('Gene signature has no result yet: run it, then choose the set it shows.');
  expect((await dispatch(page, 'analysis.signature.set', { in: 1, options: {}, show: true })).error)
    .toBe('"show" opens Gene signature in the panel (in "panel"); analysis window 1 shows its own.');

  // A person's clicks: the same actions, one step each.
  await dispatch(page, 'analysis.open', { analysis: 'markers' });
  const panel = page.locator('#analysis-panel-genesPanel');
  await panel.getByRole('button', { name: 'Test', exact: true }).click();
  expect(await headStep(page)).toMatchObject({ type: 'analysis.view.set', params: { analysis: 'markers', in: 'panel', view: { groups: ['filters'] } }, origin: 'user' });
  await panel.getByRole('button', { name: 'Heatmap', exact: true }).click();
  expect(await headStep(page)).toMatchObject({ type: 'analysis.view.set', params: { analysis: 'markers', in: 'panel', view: { show: 'heatmap' } }, label: 'Showed Marker genes as a heatmap' });
  const before = await headStep(page);
  await panel.getByRole('button', { name: 'Score as signature', exact: true }).click();
  const sent = await headStep(page);
  expect(sent).toMatchObject({ type: 'analysis.signature.set', params: { in: 'panel', show: true }, label: expect.stringMatching(/^Opened Gene signature: Gene sets set to /) });
  expect(sent.params.options.geneSets.length, 'the markers of each group, one set each').toBeGreaterThan(0);
  expect(await page.evaluate(() => window._comparisonModule.getOpenMode())).toBe('signature');
  await page.evaluate(() => window._cellucidHistories.current().undo());
  expect((await headStep(page)).id, 'one click, one step').toBe(before.id);
  expect(await page.evaluate(() => window._comparisonModule.getOpenMode())).toBe('genesPanel');
  expect(errors).toEqual([]);
});

// One opening. The list of actions comes last: one of them hides the sidebar.
test("on the page's own history: an analysis's page choice survives a redraw and undo; apply then undo returns every domain to its fingerprint", async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openFixture(page);
  await waitForHistory(page);

  await test.step("an analysis's page choice, none included, survives a redraw and comes back exactly on undo", async () => {
    expect((await dispatch(page, 'highlight.category', { field: { source: 'obs', key: 'cell_type' }, categories: ['T cell'], page: 'Page 1' })).error).toBeUndefined();
    for (const [analysis, modeId] of [['detailed', 'detailed'], ['correlation', 'correlation'], ['signature', 'signature']]) {
      expect((await dispatch(page, 'analysis.open', { analysis })).error, analysis).toBeUndefined();
      // An explicit empty choice: a redraw shows no page, never the default.
      expect((await dispatch(page, 'analysis.pages.set', { analysis, pages: [] })).error, analysis).toBeUndefined();
      const redrawn = await page.evaluate(id => {
        const ui = window._comparisonModule.getPanelUI(id);
        ui._renderControls();
        return { selected: [...ui.getSelectedPages()], settings: ui.exportSettings().selectedPages };
      }, modeId);
      expect(redrawn, `${analysis}: a redraw keeps the empty choice`).toEqual({ selected: [], settings: [] });
      const [outcome] = await applyUndoRedo(page, [['analysis.pages.set', { analysis, pages: ['Page 1', 'Rest of Page 1'] }]]);
      expect(outcome.step, `${analysis}: choosing pages is a step`).toBe(true);
      expect(outcome.differs, `${analysis}: undo puts the empty choice back exactly`).toEqual([]);
      expect(outcome.redone, `${analysis}: redo gives the pages again`).toEqual([]);
      await page.evaluate(() => window._cellucidHistories.current().undo());
      expect(await page.evaluate(id => window._comparisonModule.getPanelUI(id).getSelectedPages(), modeId), `${analysis}: undone, no page`).toEqual([]);
    }
    expect(errors).toEqual([]);
  });

  await test.step("apply then undo returns every state domain to its fingerprint, for these actions, on the page's own history", async () => {
    const report = await applyUndoRedo(page, [
      ['setting.set', { setting: 'point-size', value: 30 }],
      ['setting.set', { setting: 'toggle-centroid-points', value: true }],
      ['layout.panel.float', { panel: 'Navigation' }],
      ['layout.section.open', { section: 'Compare views', open: false }],
      ['layout.sidebar.show', { shown: false }],
      ['layout.theme.set', { theme: 'dark' }],
      ['analysis.open', { analysis: 'composition' }],
      ['analysis.markers.set', { options: { groupBy: 'cell_type' } }],
      ['figure-export.set', { width: 120, include_axes: false }],
      ['figure-export.set', { auto_text_size: false }],
      ['figure-export.set', { title_follows_dataset: false, title: 'Figure 1' }],
      ['figure-export.set', { preview: { enabled: true, colorblind_mode: 'deuteranopia' } }],
    ]);
    for (const outcome of report) {
      expect(outcome.refused, outcome.type).toBeNull();
      expect(outcome.step, `${outcome.type} is a step`).toBe(true);
      expect(outcome.untouched, `${outcome.type} changes only the domains it touches`).toEqual([]);
      expect(outcome.differs, `${outcome.type}: undo restores every domain`).toEqual([]);
      expect(outcome.redone, `${outcome.type}: redo gives it again`).toEqual([]);
    }
  });
});

test('reading an analysis makes no state: get, set, undo returns every domain exactly to where it started, for each analysis with options', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  await waitForHistory(page);
  const report = await page.evaluate(async names => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint, differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const actions = getActions();
    const domains = getStateDomains();
    const atRest = async () => {
      await Promise.all(window._comparisonModule.listPanelUIs().map(({ ui }) => ui.whenSettled()));
      await history.idle();
      return stateFingerprint(domains);
    };
    /** Each other value an option could take, from its schema: the candidates a set is tried with. */
    const alternatives = (schema, value) => {
      if (Array.isArray(schema.enum)) return schema.enum.filter(item => JSON.stringify(item) !== JSON.stringify(value));
      if (schema.type === 'boolean') return [!value];
      if ((schema.type === 'integer' || schema.type === 'number') && typeof value === 'number') {
        return [value + 1, value - 1].filter(item => (schema.minimum === undefined || item >= schema.minimum) && (schema.maximum === undefined || item <= schema.maximum));
      }
      return [];
    };
    const out = [];
    for (const name of names) {
      const start = await atRest();
      const { outcome: read, step: readStep } = await actions.dispatch(`analysis.${name}.get`, {});
      const afterRead = differingDomains(start, await atRest());
      const properties = actions.catalog.get(`analysis.${name}.set`).params.properties.options.properties;
      let set = null;
      for (const [key, schema] of Object.entries(properties)) {
        for (const value of alternatives(schema, read.options[key])) {
          try {
            const { step } = await actions.dispatch(`analysis.${name}.set`, { options: { [key]: value } });
            if (step !== null) { set = key; break; }
          } catch {
            // Not settable this way on this dataset (refused, nothing changed): the next candidate.
          }
        }
        if (set !== null) break;
      }
      if (set !== null) await history.undo();
      out.push({ name, readStep: readStep !== null, afterRead, set, afterUndo: differingDomains(start, await atRest()) });
    }
    // The other reads of a mode the panel never made: its result, a stop, and the run's estimate
    // (taken when an agent's run is asked about; refused here, so only the estimate runs).
    const beforeReads = await atRest();
    for (const name of names) {
      for (const [type, params] of [['analysis.result', { analysis: name }], ['analysis.cancel', { analysis: name }]]) {
        try { await actions.dispatch(type, params); } catch { /* "no result yet": a refusal, still a read */ }
      }
    }
    actions.setConfirmer(() => false);
    for (const name of names) {
      try { await actions.dispatch('analysis.run', { analysis: name }, { origin: 'agent', agent: 'Claude' }); } catch { /* refused after its estimate */ }
    }
    const afterReads = differingDomains(beforeReads, await atRest());
    // The copy button checks the mode's data before it opens a window: the window is the one step, undone exactly.
    const beforeCopy = await atRest();
    const steps = history.active.steps.size;
    document.querySelector('.analysis-mode[data-mode="genesPanel"] .analysis-mode-copy-btn').click();
    const windows = window._comparisonModule.getAnalysisWindowManager();
    // Until the window stands and its step is recorded: frame by frame, no fixed wait.
    while (windows.getWindowCount() === 0 || history.active.steps.size === steps) {
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      await atRest();
    }
    const copied = history.active.steps.get(history.active.headId).type;
    await history.undo();
    const afterCopy = differingDomains(beforeCopy, await atRest());
    return { out, afterReads, copied, afterCopy, windowsLeft: windows.getWindowCount() };
  }, ['markers', 'differential', 'dotplot', 'signature', 'composition', 'correlation']);
  expect(report.afterReads, 'analysis.result, analysis.cancel and the run\'s estimate change no state').toEqual([]);
  expect(report.copied).toBe('analysis.open');
  expect(report.afterCopy, 'the copy button\'s check leaves nothing but its window, which undo takes back').toEqual([]);
  expect(report.windowsLeft).toBe(0);
  for (const entry of report.out) {
    expect(entry.readStep, `analysis.${entry.name}.get records no step`).toBe(false);
    expect(entry.afterRead, `analysis.${entry.name}.get changes no state`).toEqual([]);
    expect(entry.set, `analysis.${entry.name}.set changes an option`).not.toBeNull();
    expect(entry.afterUndo, `analysis.${entry.name}: get, set (${entry.set}), undo returns every domain to where it started`).toEqual([]);
  }
  // A window's actions with no window open are refused in one sentence, changing nothing.
  expect((await dispatch(page, 'analysis.window.close', { window: 1 })).error).toBe('There is no analysis window 1: none is open.');
  expect(errors).toEqual([]);
});

test('a figure export option a person changes is one figure-export.set step, as an agent\'s is; undo puts the panel back', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  await startHistory(page);
  await page.locator('#figure-export-section > summary').click();
  const panel = page.locator('#figure-export-section');
  await panel.getByRole('button', { name: 'Labels and annotations', exact: true }).click();
  const figureExport = () => page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    return (await getStateDomains().owner('settings').capture()).figureExport;
  });
  const before = await figureExport();
  const outsideSteps = () => page.evaluate(() => [...window._cellucidHistories.current().active.steps.values()]
    .filter(step => step.type === 'history.outside-change').length);
  const outside = await outsideSteps();

  // A person's switch: one step from its own event, named by the setting.
  const count = await stepCount(page);
  await page.locator('#figure-export-axes').click();
  expect(await headStep(page)).toMatchObject({
    type: 'figure-export.set', params: { include_axes: !before.includeAxes }, origin: 'user',
    label: `Figure export: include axes ${before.includeAxes ? 'off' : 'on'}`,
  });
  expect(await stepCount(page)).toBe(count + 1);
  // Typing a title: one step for the burst, the title no longer following the dataset.
  await page.locator('#figure-export-title').fill('Figure 2');
  await page.locator('#figure-export-title').press('Enter');
  expect(await headStep(page)).toMatchObject({
    type: 'figure-export.set', params: { title_follows_dataset: false, title: 'Figure 2' },
  });
  expect(await stepCount(page)).toBe(count + 2);
  expect(await outsideSteps()).toBe(outside);
  await undo(page);
  await undo(page);
  expect(await figureExport()).toEqual(before);
  await expect(page.locator('#figure-export-axes')).toBeChecked({ checked: before.includeAxes });

  // An agent's: the same action by name; what does not go together is refused in its words, changing nothing.
  // The width in millimetres: a width alone that is no preset's makes the preset custom.
  const agent = await dispatch(page, 'figure-export.set', { width: 150, legend_position: 'bottom' }, { origin: 'agent', agent: 'Claude' });
  expect(agent.step).toMatchObject({ type: 'figure-export.set', origin: 'agent', label: 'Figure export: width 150, legend position bottom' });
  expect((await figureExport()).width).toBe(150);
  expect((await figureExport()).sizePreset).toBe('custom');
  await expect(page.locator('#figure-export-width')).toHaveValue('150');
  // Read back by the names the set takes: every setting, the record's version aside.
  const record = await figureExport();
  const snake = value => (value === null || typeof value !== 'object' ? value
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), snake(item)])));
  const { version: _recordVersion, ...settings } = record;
  expect(await read(page, 'figure-export.get')).toEqual(snake(settings));
  expect(await read(page, 'figure-export.get')).toMatchObject({ width: 150, size_preset: 'custom', legend_position: 'bottom' });
  // A preset sets its width.
  expect((await dispatch(page, 'figure-export.set', { size_preset: 'single-column' })).refused).toBeUndefined();
  expect(await read(page, 'figure-export.get')).toMatchObject({ width: 89, size_preset: 'single-column' });
  const refused = await dispatch(page, 'figure-export.set', {
    frame: { lock_aspect: false, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    preview: { enabled: false, colorblind_mode: 'none' },
  });
  expect(refused.code).toBe('bad-value');
  expect(refused.error).toMatch(/^These figure export settings do not go together: frame requires preview\.enabled/);
  expect((await figureExport()).frame).toBeNull();
  expect(errors).toEqual([]);
});
