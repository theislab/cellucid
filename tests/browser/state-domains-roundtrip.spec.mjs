/**
 * Every state domain comes back exactly (`assets/js/app/state/domains/`).
 *
 * For each domain the state is changed through the interface, every domain is
 * captured, the state is changed again, and the domains whose values differ
 * are restored in domain order, as the history does when it shows a step
 * (`app/history/history.js` `restoreTo`). Then the fingerprint (one digest of
 * every domain) is the captured one, what the person sees is what was shown
 * (legend, counts, selects, views, highlights, panels, theme, the colours and
 * visibility of every view), and restoring again changes nothing.
 *
 * Covered across the live view and a kept view, after a data-mapping change
 * (the mapping is restored first, and the views and fields read against it),
 * and on a subsample (cells by original position).
 *
 * Two domains have no control in the interface and are changed the way a
 * notebook changes them: cells hidden one by one (`setVisibility`, here
 * `setCellVisibility`) and gene sets (`setGeneSet`, here
 * `upsertNotebookGeneSet`).
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { chooseFiles } from './helpers/file-input.mjs';
import { waitForDatasetReady, waitForPageAtRest, whenActionsDone } from './helpers/dataset-ready.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CURRENT_UI_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=state-domains-ci`;

const URLS = Object.freeze({
  actions: '/assets/js/app/actions/index.js',
  domains: '/assets/js/app/actions/domains.js',
  fingerprint: '/assets/js/app/state/domains/fingerprint.js',
  pool: '/assets/js/app/history/value-pool.js',
});

function collectProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Capture every domain, keep the values in the page under `name`, give the fingerprint. */
function captureAll(page, name) {
  return page.evaluate(async ({ name: key, urls }) => {
    const { getStateDomains } = await import(urls.actions);
    const { captureEveryDomain, fingerprintOf } = await import(urls.fingerprint);
    const values = await captureEveryDomain(getStateDomains());
    (window.__stateDomainValues ??= {})[key] = values;
    return fingerprintOf(values);
  }, { name, urls: URLS });
}

function fingerprint(page) {
  return page.evaluate(async urls => {
    const { getStateDomains } = await import(urls.actions);
    const { stateFingerprint } = await import(urls.fingerprint);
    return stateFingerprint(getStateDomains());
  }, URLS);
}

/**
 * Restore, in domain order, every domain whose value differs from the one
 * captured under `name`, each compared again just before it (an earlier
 * domain's restore may have brought it back already, as a mapping does for
 * the views that follow its default). Returns the domains restored.
 */
function restoreAll(page, name) {
  return page.evaluate(async ({ name: key, urls }) => {
    const { getStateDomains } = await import(urls.actions);
    const { DOMAIN_IDS } = await import(urls.domains);
    const { hashValue } = await import(urls.pool);
    const domains = getStateDomains();
    const saved = window.__stateDomainValues[key];
    const restored = [];
    for (const id of DOMAIN_IDS) {
      const owner = domains.owner(id);
      if (await hashValue(await owner.capture()) === await hashValue(saved[id])) continue;
      await owner.restore(saved[id]);
      restored.push(id);
    }
    return restored;
  }, { name, urls: URLS });
}

/** A domain's value captured under `name`, as JSON (typed arrays as lists). */
function savedValue(page, name, id) {
  return page.evaluate(({ key, domain }) => JSON.parse(JSON.stringify(
    window.__stateDomainValues[key][domain],
    (_k, value) => (ArrayBuffer.isView(value) ? Array.from(value) : value),
  )), { key: name, domain: id });
}

/** What a person sees, read from the page and from what each view draws. */
function shown(page) {
  return page.evaluate(async () => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const digest = async array => {
      if (!ArrayBuffer.isView(array)) return null;
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    };
    const text = element => (element === null ? null : element.textContent.replace(/\s+/g, ' ').trim());
    const ids = ['live', ...viewer.getSnapshotViews().map(snapshot => snapshot.id)];
    const views = [];
    for (const id of ids) {
      views.push({
        transparency: await digest(viewer.getViewTransparency(id)),
        camera: viewer.getViewCameraState(id),
        centroids: viewer.getCentroidFlags(id),
        layout: state.getViewLayoutKey(id),
      });
    }
    const badges = [...document.querySelectorAll('.split-badge')];
    return {
      filterCount: text(document.getElementById('filter-count')),
      categorical: document.getElementById('categorical-field').selectedOptions[0]?.textContent ?? null,
      continuous: document.getElementById('continuous-field').selectedOptions[0]?.textContent ?? null,
      gene: document.getElementById('gene-expression-search').value,
      legend: [...document.querySelectorAll('.legend-item')].map(row => ({
        label: text(row.querySelector('.legend-label-main')),
        shown: row.querySelector('.legend-checkbox')?.checked ?? null,
        color: row.querySelector('.legend-color-input')?.value ?? null,
        highlighted: row.querySelector('.legend-highlight-btn')?.getAttribute('aria-pressed') ?? null,
      })),
      badges: badges.length,
      activeBadge: badges.findIndex(badge => badge.classList.contains('active')),
      viewLayout: document.getElementById('view-layout-mode').value,
      navigation: document.getElementById('navigation-mode').value,
      highlightPages: [...document.querySelectorAll('.highlight-page-tab')].map(tab => text(tab)),
      highlighted: state.getHighlightedCellCount(),
      theme: document.documentElement.dataset.theme ?? null,
      sidebarHidden: document.getElementById('sidebar').classList.contains('hidden'),
      floating: [...document.querySelectorAll('#floating-panels-root details.accordion-section')].map(details => details.id).sort(),
      open: [...document.querySelectorAll('details.accordion-section')].filter(details => details.open).map(details => details.id).sort(),
      keyframes: document.querySelectorAll('.cinematic-keyframe-item').length,
      pointSize: document.getElementById('point-size').value,
      colors: await digest(state.colorsArray),
      views,
    };
  });
}

/**
 * The round trip of one change: `first` (through the interface), capture,
 * `second`, restore; the fingerprint, the visible state and the value of
 * `domain` are back, and a second restore changes nothing.
 */
async function roundTrip(page, { name, domain, first, second }) {
  // Each change is made through the interface, as an action, and is done
  // when the dispatcher says so (a field chosen is read first): the domains
  // are captured and restored directly below, outside the dispatcher's
  // order, so a restore made while the second change was still being applied
  // was overtaken by it (WebKit, 1 run in 14: the state named `cell_type`,
  // and the select, the legend and the colours showed none).
  await first(page);
  await whenActionsDone(page);
  await waitForPageAtRest(page);
  const captured = await captureAll(page, name);
  const before = await shown(page);
  await second(page);
  await whenActionsDone(page);
  await waitForPageAtRest(page);
  const changed = await fingerprint(page);
  const differing = Object.keys(captured.domains).filter(id => captured.domains[id] !== changed.domains[id]);
  expect(differing, `${name}: the second change reaches ${domain}`).toContain(domain);
  const restored = await restoreAll(page, name);
  // A domain restored earlier may bring a later one back itself (a mapping
  // moves the views that follow its default), so it is not restored again.
  expect(restored, `${name}: restored`).toContain(domain);
  for (const id of restored) expect(differing, `${name}: only what differed is restored`).toContain(id);
  await waitForPageAtRest(page);
  const after = await fingerprint(page);
  expect(after.domains, `${name}: every domain's value is back`).toEqual(captured.domains);
  expect(after.digest).toBe(captured.digest);
  expect(await shown(page), `${name}: what is shown is back`).toEqual(before);
  expect(await restoreAll(page, name), `${name}: a second restore changes nothing`).toEqual([]);
  return captured;
}

function legendRow(page, label) {
  return page.locator('.legend-item', { has: page.locator('.legend-label-main', { hasText: new RegExp(`^${label}$`) }) });
}

async function openCurrentUi(page) {
  await page.goto(CURRENT_UI_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForDatasetReady(page, 120);
  await waitForPageAtRest(page);
}

/** Set a range control as a drag of it does: its value, then its `input` event. */
async function slide(page, id, value) {
  await page.locator(`#${id}`).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function renameCategory(page, label, name) {
  await legendRow(page, label).locator('.legend-rename-btn').click();
  const editor = page.locator('.inline-rename-input');
  await editor.fill(name);
  await editor.press('Enter');
  await expect(legendRow(page, name)).toHaveCount(1);
}

/** A point of the plot, beside the sidebar, where the viewer picks a cell (the `skip`-th found). */
async function cellPoint(page, skip = 0) {
  const point = await page.evaluate(wanted => {
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas').getBoundingClientRect();
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    const left = Math.max(canvas.left, sidebar.right) + 20;
    const seen = new Set();
    for (let y = canvas.top + 20; y < canvas.bottom - 20; y += 4) {
      for (let x = left; x < canvas.right - 20; x += 4) {
        const cell = viewer.pickCellAtScreen(x, y);
        if (cell < 0 || seen.has(cell)) continue;
        seen.add(cell);
        if (seen.size > wanted) return { x, y, cell };
      }
    }
    return null;
  }, skip);
  expect(point, 'a cell is drawn beside the sidebar').not.toBeNull();
  return point;
}

/** Highlight the category of a cell with the annotation tool: Alt+click it, then Confirm. */
async function highlightCellCategory(page, skip = 0) {
  const point = await cellPoint(page, skip);
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.mouse.move(point.x + 40, point.y + 40);
  await page.locator('#annotation-confirm-btn').click();
  await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
}

async function dragCanvas(page, dx, dy) {
  const box = await page.locator('#glcanvas').boundingBox();
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test('every domain changed through the interface comes back exactly', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectProductErrors(page);
  await openCurrentUi(page);

  await roundTrip(page, {
    name: 'active-field',
    domain: 'active-field',
    first: async p => p.locator('#categorical-field').selectOption({ label: 'cell_type' }),
    second: async p => p.locator('#continuous-field').selectOption({ label: 'score' }),
  });
  expect(await savedValue(page, 'active-field', 'active-field')).toEqual({ views: [{ source: 'obs', key: 'cell_type' }] });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await roundTrip(page, {
    name: 'filters',
    domain: 'filters',
    first: async p => {
      await legendRow(p, 'alpha').locator('.legend-checkbox').uncheck();
      await expect(p.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
    },
    second: async p => {
      await legendRow(p, 'alpha').locator('.legend-checkbox').check();
      await legendRow(p, 'beta').locator('.legend-checkbox').uncheck();
      await expect(p.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
    },
  });
  await expect(legendRow(page, 'alpha').locator('.legend-checkbox')).not.toBeChecked();
  await expect(legendRow(page, 'beta').locator('.legend-checkbox')).toBeChecked();

  const colors = await roundTrip(page, {
    name: 'colors',
    domain: 'colors',
    first: async p => legendRow(p, 'gamma').locator('.legend-color-input').fill('#ff0000'),
    second: async p => {
      await legendRow(p, 'gamma').locator('.legend-color-input').fill('#00ff00');
      await legendRow(p, 'beta').locator('.legend-color-input').fill('#0000ff');
    },
  });
  expect(colors.domains.colors).toMatch(/^[0-9a-f]{64}$/);
  expect(await savedValue(page, 'colors', 'colors')).toEqual({
    views: [[{ field: { source: 'obs', key: 'cell_type' }, colors: [{ category: 'gamma', color: '#ff0000' }] }]],
  });
  await expect(legendRow(page, 'gamma').locator('.legend-color-input')).toHaveValue('#ff0000');

  await roundTrip(page, {
    name: 'field-overlays',
    domain: 'field-overlays',
    first: async p => renameCategory(p, 'gamma', 'Gamma cells'),
    second: async p => {
      await renameCategory(p, 'beta', 'Beta cells');
      await p.locator('#rename-categorical-field').click();
      const editor = p.locator('.inline-rename-input');
      await editor.fill('cell types');
      await editor.press('Enter');
      await expect(p.locator('#categorical-field option:checked')).toHaveText(/cell types/);
    },
  });
  await expect(legendRow(page, 'Gamma cells')).toHaveCount(1);
  await expect(legendRow(page, 'beta')).toHaveCount(1);
  const overlays = await savedValue(page, 'field-overlays', 'field-overlays');
  expect(overlays.renamedCategories).toEqual([{ source: 'obs', field: 'cell_type', category: 'gamma', name: 'Gamma cells' }]);
  expect(overlays.renamedFields).toEqual([]);

  await roundTrip(page, {
    name: 'highlights',
    domain: 'highlights',
    first: async p => highlightCellCategory(p),
    second: async p => highlightCellCategory(p),
  });
  const highlights = await savedValue(page, 'highlights', 'highlights');
  // `alpha` is hidden: the cell picked is of beta or gamma, 40 cells each.
  expect(highlights.pages[0].groups.map(group => [group.type, group.cells.length])).toEqual([['annotation', 40]]);
  // Every cell open: a group's cells are its rows of the file.
  const gammaRows = await page.evaluate(() => {
    const state = window._cellucidState;
    const group = state.getHighlightPages()[0].highlightedGroups[0];
    return Array.from(state.cellIdentity.toOriginal(group.cellIndices)).sort((a, b) => a - b);
  });
  expect(highlights.pages[0].groups[0].cells).toEqual(gammaRows);

  await roundTrip(page, {
    name: 'camera',
    domain: 'camera',
    first: async p => dragCanvas(p, 60, 20),
    second: async p => {
      await p.locator('#navigation-mode').selectOption('free');
      await dragCanvas(p, -40, 30);
    },
  });

  await roundTrip(page, {
    name: 'settings',
    domain: 'settings',
    first: async p => slide(p, 'point-size', 7),
    second: async p => {
      await slide(p, 'point-size', 3);
      await p.locator('#highlight-mode button[aria-pressed="false"]').first().click();
    },
  });
  await expect(page.locator('#point-size')).toHaveValue('7');

  await page.locator('#cinematic-camera-section > summary').click();
  await roundTrip(page, {
    name: 'camera-path',
    domain: 'camera-path',
    first: async p => {
      await p.locator('#cinematic-save-btn').click();
      await expect(p.locator('.cinematic-keyframe-item')).toHaveCount(1);
    },
    second: async p => {
      await dragCanvas(p, 30, 0);
      await p.locator('#cinematic-save-btn').click();
      await expect(p.locator('.cinematic-keyframe-item')).toHaveCount(2);
      await p.locator('#cinematic-loop').check();
    },
  });
  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(1);

  await roundTrip(page, {
    name: 'layout',
    domain: 'layout',
    first: async p => {
      const theme = await p.evaluate(() => document.documentElement.dataset.theme);
      await p.locator('#theme-select').selectOption(theme === 'dark' ? 'light' : 'dark');
    },
    second: async p => {
      const theme = await p.evaluate(() => document.documentElement.dataset.theme);
      await p.locator('#theme-select').selectOption(theme === 'dark' ? 'light' : 'dark');
      await p.locator('.accordion-panel:has(> #navigation-section) > .accordion-panel-actions > .accordion-undock-btn').click();
      await expect(p.locator('.accordion-panel:has(> #navigation-section)')).toHaveClass(/accordion-floating/);
      await p.locator('#visualization-section > summary').click();
      await p.locator('#sidebar-toggle').click();
      await expect(p.locator('#sidebar')).toHaveClass(/hidden/);
    },
  });
  await expect(page.locator('#sidebar')).not.toHaveClass(/hidden/);
  await expect(page.locator('#floating-panels-root #navigation-section')).toHaveCount(0);

  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const modes = page.locator('#page-analysis-section [id^="analysis-header-"]');
  await roundTrip(page, {
    name: 'analysis',
    domain: 'analysis',
    first: async () => modes.first().click(),
    second: async () => modes.nth(1).click(),
  });

  await roundTrip(page, {
    name: 'visibility',
    domain: 'visibility',
    first: async p => p.evaluate(() => window._cellucidState.setCellVisibility(Uint32Array.of(0, 1, 2), false)),
    second: async p => p.evaluate(() => {
      window._cellucidState.setCellVisibility(null, true);
      window._cellucidState.setCellVisibility(Uint32Array.of(5, 6), false);
    }),
  });
  expect(await savedValue(page, 'visibility', 'visibility')).toEqual({ views: [[0, 1, 2]] });

  await roundTrip(page, {
    name: 'gene-sets',
    domain: 'gene-sets',
    first: async p => p.evaluate(() => window._cellucidState.getDerivedResults()
      .upsertNotebookGeneSet({ name: 'T cells', description: 'from a notebook', genes: ['CD3E', 'GAPDH'] })),
    second: async p => p.evaluate(() => window._cellucidState.getDerivedResults()
      .upsertNotebookGeneSet({ name: 'B cells', description: '', genes: ['MS4A1'] })),
  });
  expect(await savedValue(page, 'gene-sets', 'gene-sets')).toEqual({
    sets: [{ name: 'T cells', description: 'from a notebook', genes: ['CD3E', 'GAPDH'] }],
  });

  await roundTrip(page, {
    name: 'views',
    domain: 'views',
    first: async p => {
      await p.locator('#split-keep-view-btn').click();
      await expect(p.locator('.split-badge')).toHaveCount(2);
    },
    second: async p => {
      await p.locator('#split-keep-view-btn').click();
      await expect(p.locator('.split-badge')).toHaveCount(3);
      await p.locator('#view-layout-mode').selectOption('single');
      await p.locator('#camera-lock-btn').click();
    },
  });
  await expect(page.locator('.split-badge')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('per-view state comes back for the live view and a kept view alike', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectProductErrors(page);
  await openCurrentUi(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  // The kept view is focused: its own filter, colour, field and hidden cells.
  await legendRow(page, 'alpha').locator('.legend-checkbox').uncheck();
  await legendRow(page, 'beta').locator('.legend-color-input').fill('#123456');
  await page.evaluate(() => window._cellucidState.setCellVisibility(Uint32Array.of(3), false));
  // The live view: another field.
  await page.locator('.split-badge').nth(0).locator('.split-badge-select').click();
  await page.locator('#continuous-field').selectOption({ label: 'score' });

  await roundTrip(page, {
    name: 'two views',
    domain: 'filters',
    first: async () => {},
    second: async p => {
      await p.locator('#categorical-field').selectOption({ label: 'cell_type' });
      await legendRow(p, 'gamma').locator('.legend-checkbox').uncheck();
      await p.locator('.split-badge').nth(1).locator('.split-badge-select').click();
      await legendRow(p, 'alpha').locator('.legend-checkbox').check();
      await legendRow(p, 'beta').locator('.legend-color-input').fill('#654321');
      await p.evaluate(() => window._cellucidState.setCellVisibility(null, true));
      await dragCanvas(p, 40, 10);
    },
  });
  const views = await page.evaluate(urls => import(urls.actions)
    .then(({ getStateDomains }) => Promise.all(['active-field', 'filters', 'colors', 'visibility']
      .map(id => getStateDomains().owner(id).capture())))
    .then(values => JSON.parse(JSON.stringify(values, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)))), URLS);
  const [active, filters, colors, visibility] = views;
  expect(active.views).toEqual([{ source: 'obs', key: 'score' }, { source: 'obs', key: 'cell_type' }]);
  expect(filters.views).toEqual([[], [{ field: { source: 'obs', key: 'cell_type' }, hidden: ['alpha'] }]]);
  expect(colors.views[0]).toEqual([]);
  expect(colors.views[1]).toEqual([{ field: { source: 'obs', key: 'cell_type' }, colors: [{ category: 'beta', color: '#123456' }] }]);
  expect(visibility.views).toEqual([[], [3]]);
  expect(errors).toEqual([]);
});

test('after a data-mapping change, the mapping, every view\'s embedding and the fields come back', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectProductErrors(page);
  await openSessionSectionsOnLoad(page);
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), path.join(FIXTURES, 'data-mapping-multi.h5ad'));
  await expect(page.locator('#dataset-name')).toHaveText('data-mapping-multi');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getMappingCandidates() !== null)).toBe(true);
  await waitForPageAtRest(page);
  // A kept view turned to t-SNE; the live view follows the 2-D default.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await page.locator('#view-representation-select').selectOption('X_tsne');
  const category = await page.evaluate(() => window._cellucidState.obsData.fields.find(field => field.kind === 'category').key);
  await page.locator('#categorical-field').selectOption({ label: category });
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null)).toBe(category);

  await roundTrip(page, {
    name: 'mapping',
    domain: 'mapping',
    first: async () => {},
    second: async p => {
      await p.locator('#data-mapping-disclosure > .disclosure-header-row > .disclosure-header').click();
      const more = p.locator('#data-mapping-more .disclosure-header');
      if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
      const pca = p.locator('.data-mapping-row').filter({ has: p.locator('.data-mapping-name', { hasText: /^PCA 1,2$/ }) });
      await pca.locator('.data-mapping-enable').check();
      await pca.locator('.data-mapping-default').click();
      await p.locator('#data-mapping-apply').click();
      await expect(p.locator('.data-mapping-status')).toHaveText('Applied.');
      await legendRow(p, await p.evaluate(() => window._cellucidState.getActiveField().categories[0]).then(String))
        .locator('.legend-checkbox').uncheck();
    },
  });
  const layouts = await page.evaluate(() => ['live', ...window._cellucidViewer.getSnapshotViews().map(s => s.id)]
    .map(id => window._cellucidState.getViewLayoutKey(id)));
  expect(layouts[1]).toBe('X_tsne');
  expect(layouts[0]).not.toMatch(/pca/i);
  expect(errors).toEqual([]);
});

test('on a subsample, cells are named by original position and come back on the open cells', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectProductErrors(page);
  const bytes = await readFile(path.join(FIXTURES, 'data-mapping-full.h5ad'));
  const url = `${SAMPLE_ORIGIN}/state-domains/data-mapping-full.h5ad`;
  await page.route(url, route => fulfillFile(route, bytes));
  // A data link opens its dataset without the welcome dialog.
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}&cells=40%25&sample=uniform&seed=3`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await waitForDatasetReady(page, 120);
  await waitForPageAtRest(page);
  expect(await page.evaluate(() => window._cellucidState.cellIdentity.isSubset)).toBe(true);
  const category = await page.evaluate(() => window._cellucidState.obsData.fields.find(field => field.kind === 'category').key);
  await page.locator('#categorical-field').selectOption({ label: category });
  // Choosing a field reads it first.
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null)).toBe(category);
  await expect(page.locator('.legend-item').first()).toBeVisible();
  const firstCategory = await page.evaluate(() => String(window._cellucidState.getActiveField().categories[0]));

  await roundTrip(page, {
    name: 'subsample',
    domain: 'highlights',
    first: async p => {
      await highlightCellCategory(p);
      await p.evaluate(() => window._cellucidState.setCellVisibility(Uint32Array.of(0, 7), false));
    },
    second: async p => {
      await legendRow(p, firstCategory).locator('.legend-checkbox').uncheck();
      await highlightCellCategory(p);
      await p.evaluate(() => window._cellucidState.setCellVisibility(null, true));
    },
  });
  const named = await page.evaluate(() => {
    const state = window._cellucidState;
    const identity = state.cellIdentity;
    const group = state.getHighlightPages()[0].highlightedGroups[0];
    return {
      group: Array.from(identity.toOriginal(group.cellIndices)).sort((a, b) => a - b),
      hidden: Array.from(identity.toOriginal(Uint32Array.of(0, 7))).sort((a, b) => a - b),
      nOriginal: identity.nOriginal,
    };
  });
  const highlights = await savedValue(page, 'subsample', 'highlights');
  const visibility = await savedValue(page, 'subsample', 'visibility');
  expect(highlights.pages[0].groups[0].cells).toEqual(named.group);
  expect(visibility.views[0]).toEqual(named.hidden);
  expect(named.nOriginal).toBe(300);
  expect(errors).toEqual([]);
});
