/**
 * A categorical field whose cells hold codes above 65,535 behaves exactly like
 * any other through every consumer: colour, legend filter, Alt+click
 * selection and highlight, a kept second view, figure export, and a session
 * round trip. Codes are placed so that any 16-bit truncation (code mod
 * 65,536) lands one category on another and fails an exact assertion:
 * alpha sits at 65,536 (which truncates onto gamma at 0) and beta at 69,999.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

// `scripts/generate-browser-catalog-fixtures.py`: the current-ui cells, whose
// cell_type cycles alpha, beta, gamma, with a 70,000-category inventory.
const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'uint32-categories.h5ad',
);

const UINT32_MISSING = 4_294_967_295;
/** Where each label sits in the inventory. */
const PLACEMENT = Object.freeze({ alpha: 65_536, beta: 69_999, gamma: 0 });
const GESTURE_LANDING_TIMEOUT_MS = 3_000;

/** The fixture's codes: the first five gamma cells are missing. */
function fixtureCodes() {
  const labels = ['alpha', 'beta', 'gamma'];
  return Array.from({ length: 120 }, (_, cell) => {
    const label = labels[cell % 3];
    return label === 'gamma' && cell < 15 ? UINT32_MISSING : PLACEMENT[label];
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
  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await chooseFiles(page.locator('#user-data-file-input'), fixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('uint32 categories');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
}

/** The live field, its codes, and what one view publishes for it. */
function readView(page, viewId) {
  return page.evaluate(id => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const field = state.getFieldForView(id);
    const colors = viewer.getViewColors(id);
    const rgb = [];
    for (let cell = 0; cell < colors.length / 4; cell++) {
      rgb.push(`${colors[cell * 4]},${colors[cell * 4 + 1]},${colors[cell * 4 + 2]}`);
    }
    return {
      key: field?.key ?? null,
      codesType: field?.codes?.constructor?.name ?? null,
      codes: field?.codes ? Array.from(field.codes) : null,
      rgb,
      transparency: Array.from(viewer.getViewTransparency(id)),
    };
  }, viewId);
}

/** One colour per label, every cell of a label in it, no two labels sharing. */
function expectColoursFollowLabels(view, codes) {
  const colourByCode = new Map();
  for (let cell = 0; cell < codes.length; cell++) {
    const code = codes[cell];
    if (!colourByCode.has(code)) colourByCode.set(code, view.rgb[cell]);
    expect(view.rgb[cell], `cell ${cell} (code ${code})`).toBe(colourByCode.get(code));
  }
  expect(new Set(colourByCode.values()).size).toBe(colourByCode.size);
}

function legendRow(page, label) {
  return page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: new RegExp(`^${label}$`) }),
  });
}

/**
 * The legend lists categories by label, so alpha, beta and gamma are its first
 * rows whatever their codes; scroll it to the top, where they are built.
 */
async function scrollLegendToTop(page) {
  await page.locator('.legend-items-container.legend-items-virtual').evaluate(list => {
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
  });
}

async function findCellPoint(page, cellIndices) {
  const point = await page.evaluate(wanted => {
    const viewer = window._cellucidViewer;
    const targets = new Set(wanted);
    for (let y = 40; y < 980; y += 4) {
      for (let x = 340; x < 1430; x += 4) {
        const cell = viewer.pickCellAtScreen(x, y);
        if (targets.has(cell)) return { x, y, cell };
      }
    }
    return null;
  }, cellIndices);
  expect(point).not.toBeNull();
  return point;
}

async function altClick(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.mouse.move(point.x + 40, point.y + 40);
}

async function armAnnotation(page, point) {
  const controls = page.locator('#annotation-step-controls');
  for (let attempt = 0; attempt < 8; attempt++) {
    await altClick(page, point);
    const armed = await controls.waitFor({
      state: 'attached',
      timeout: GESTURE_LANDING_TIMEOUT_MS,
    }).then(() => true, error => {
      if (error?.name !== 'TimeoutError') throw error;
      return false;
    });
    if (armed) return;
  }
  await expect(controls).toBeVisible();
}

function highlightedCells(page) {
  return page.evaluate(() => {
    const highlight = window._cellucidState.highlightArray;
    const cells = [];
    for (let cell = 0; cell < highlight.length; cell++) {
      if (highlight[cell] > 0) cells.push(cell);
    }
    return cells;
  });
}

test('codes above 65,535 keep their category through colour, filter, selection, views, export and sessions', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const codes = fixtureCodes();
  const cellsOf = label => codes.flatMap((code, cell) => (code === PLACEMENT[label] ? [cell] : []));
  const alphaCells = cellsOf('alpha');
  const betaCells = cellsOf('beta');
  expect(alphaCells).toHaveLength(40);
  expect(betaCells).toHaveLength(40);
  const errors = observeProductErrors(page);

  await openFixture(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-items-container.legend-items-virtual')).toBeVisible();

  // Colour: the field keeps its uint32 codes exactly, and every label paints
  // its own colour.
  let live = await readView(page, 'live');
  expect(live.key).toBe('cell_type');
  expect(live.codesType).toBe('Uint32Array');
  expect(live.codes).toEqual(codes);
  expectColoursFollowLabels(live, codes);

  // Filter: hiding alpha (code 65,536) hides exactly its 40 cells, and gamma
  // (code 0, where a truncated 65,536 would land) stays.
  await scrollLegendToTop(page);
  await legendRow(page, 'alpha').locator('.legend-checkbox').uncheck();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  live = await readView(page, 'live');
  expect(live.transparency).toEqual(codes.map(code => (code === PLACEMENT.alpha ? 0 : 1)));

  // Selection and highlight: Alt+click a beta cell (code 69,999) selects the
  // beta category, and confirming highlights exactly its cells.
  const point = await findCellPoint(page, betaCells);
  await armAnnotation(page, point);
  await expect.poll(async () => (
    await page.evaluate(() => window._cellucidViewer.getUnifiedSelectionState().candidateCount)
  )).toBe(40);
  await page.locator('#annotation-confirm-btn').click();
  await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
  await expect.poll(() => highlightedCells(page)).toEqual(betaCells);

  // A kept second view shows the same field with the same codes and colours.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const keptId = await page.evaluate(() => window._cellucidState.activeViewId);
  expect(keptId).not.toBe('live');
  const kept = await readView(page, keptId);
  expect(kept.codesType).toBe('Uint32Array');
  expect(kept.codes).toEqual(codes);
  expect(kept.rgb).toEqual(live.rgb);
  expect(kept.transparency).toEqual(live.transparency);

  // Figure export: the SVG carries the visible cells in their own colours,
  // and no alpha (hidden) colour.
  await page.locator('#figure-export-section > summary').click();
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const svg = (await readFile(await download.path())).toString('utf8');
  const hex = rgb => `#${rgb.split(',').map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
  const svgLower = svg.toLowerCase();
  const rgbOrHex = rgb => svgLower.includes(hex(rgb)) || svgLower.includes(`rgb(${rgb})`);
  expect(rgbOrHex(live.rgb[betaCells[0]])).toBe(true);
  const gammaCell = codes.indexOf(PLACEMENT.gamma);
  expect(rgbOrHex(live.rgb[gammaCell])).toBe(true);

  // Session round trip: the saved state restores the same codes, the same
  // filter and the same highlight into a fresh page.
  const sessionDownload = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const sessionPath = testInfo.outputPath('uint32.cellucid-session');
  await (await sessionDownload).saveAs(sessionPath);

  await openFixture(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooserPromise).setFiles(sessionPath);
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  await expect.poll(() => highlightedCells(page)).toEqual(betaCells);
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const restored = await readView(page, 'live');
  expect(restored.codesType).toBe('Uint32Array');
  expect(restored.codes).toEqual(codes);
  expect(restored.transparency).toEqual(live.transparency);
  expectColoursFollowLabels(restored, codes);

  expect(errors).toEqual([]);
});
