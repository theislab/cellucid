/**
 * Named views (bug hunt F130): a view can be given a name, in its row of
 * Compare views (double-click, or F2) and by `view.rename`, and the name is
 * shown wherever the view is: its row, its pane's title chip, the history's
 * step, a figure's panel title and provenance, the views read; it is one
 * step (undone and redone exactly), kept by a saved session and put back by
 * loading it. A name of the form "View N" is refused on the field, which
 * stays open; Escape leaves the view as it was.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { historyFacts, waitForHistory } from './helpers/state-history.mjs';
import { clickLoadSession, clickSaveSession } from './helpers/session-buttons.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=view-names`;

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Each row of Compare views: its number, name (or null) and what it shows. */
function readRows(page) {
  return page.locator('#split-view-badges-list .split-badge').evaluateAll(rows => rows.map(row => ({
    number: row.querySelector('.split-badge-pill').textContent,
    name: row.querySelector('.split-badge-name')?.textContent ?? null,
  })));
}

/** The pane title chips on the plot, in order. */
function readChips(page) {
  return page.locator('.view-title-chip').evaluateAll(chips => chips.map(chip => chip.textContent));
}

function viewNames(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    return ['live', ...viewer.getSnapshotViews().map(view => view.id)].map(id => viewer.getViewName(id));
  });
}

function dispatch(page, type, params) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome } = await getActions().dispatch(actionType, actionParams);
      return { outcome };
    } catch (error) {
      return { refused: error.message };
    }
  }, [type, params]);
}

/** The newest step's label. */
async function lastLabel(page) {
  const facts = await historyFacts(page);
  return facts.labels[facts.head];
}

/** Every view of the grid as one SVG figure (Export all views), its text and embedded JSON. */
function gridFigure(page) {
  return page.evaluate(async () => {
    const figure = window._cellucidUi.figureExport;
    const { blob, filename } = await figure.renderFigure({
      axisLabelFontSizePx: 12, background: 'white', backgroundColor: '#ffffff', centroidLabelFontSizePx: 12,
      crop: null, depthSort3d: true, dpi: null, emphasizeSelection: false, exportAllViews: true,
      fontFamily: 'Arial, Helvetica, sans-serif', fontSizePx: 12, format: 'svg', height: 500,
      includeAxes: false, includeLegend: false, legendFontSizePx: 12, legendPosition: 'right',
      optimizedTargetCount: null, referenceGrid: null, selectionMutedOpacity: 0.15, showOrientation: false,
      signal: new AbortController().signal, strategy: 'full-vector', tickFontSizePx: 12, title: 'Time course',
      titleFontSizePx: 15, width: 900, xLabel: '', yLabel: '',
    });
    const svg = await blob.text();
    const json = /<cellucid:json>([\s\S]*?)<\/cellucid:json>/.exec(svg)?.[1] ?? null;
    const decoded = json === null ? null : new DOMParser().parseFromString(`<x>${json}</x>`, 'text/xml').documentElement.textContent;
    return { svg, filename, provenance: decoded === null ? null : JSON.parse(decoded) };
  });
}

test('a view is named in its row and by view.rename; the name shows on the pane, in the history, a figure and a session', async ({ page }, testInfo) => {
  const errors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);

  // Three views side by side: the live view and two kept views.
  await page.locator('#split-keep-view-btn').click();
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('#split-view-badges-list .split-badge')).toHaveCount(3);
  await expect(page.locator('.view-title-chip')).toHaveCount(3);

  // Double-click the second row: its first line becomes a field; Enter names the view.
  await page.locator('#split-view-badges-list .split-badge').nth(1).locator('.split-badge-label').dblclick();
  const field = page.locator('#split-view-badges-list .split-badge-name-input');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('placeholder', 'View 2');
  await field.fill('Early');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(() => readRows(page)).toEqual([
    { number: '1', name: null },
    { number: '2', name: 'Early' },
    { number: '3', name: null },
  ]);
  await expect.poll(async () => (await readChips(page))[1]).toMatch(/^2 · Early · /);
  expect(await lastLabel(page)).toBe('Named View 2 "Early"');

  // F2 on the third row's button names it from the keyboard.
  await page.locator('#split-view-badges-list .split-badge').nth(2).locator('.split-badge-select').focus();
  await page.keyboard.press('F2');
  await expect(field).toBeFocused();
  await page.keyboard.type('Late');
  await page.keyboard.press('Enter');
  await expect.poll(() => viewNames(page)).toEqual([null, 'Early', 'Late']);
  await expect(page.locator('#split-view-badges-list .split-badge').nth(2).locator('.split-badge-select')).toBeFocused();

  // "View 3" is how views are numbered: said on the field, which stays open; Escape leaves the view as it was.
  await page.locator('#split-view-badges-list .split-badge').nth(0).locator('.split-badge-label').dblclick();
  await field.fill('View 3');
  await field.press('Enter');
  await expect(field).toBeVisible();
  expect(await field.evaluate(input => input.validationMessage)).toBe('"View 3" is how views are numbered; give the view another name, or none to number it again.');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  expect(await viewNames(page)).toEqual([null, 'Early', 'Late']);
  await page.screenshot({ path: testInfo.outputPath('view-names-rows-and-chips.png') });

  // The live view by the action, as an agent names it; Undo takes the name off, Redo gives it back.
  expect(await dispatch(page, 'view.rename', { view: 'View 1', name: 'Base' })).toEqual({ outcome: { view: 'View 1' } });
  expect(await lastLabel(page)).toBe('Named View 1 "Base"');
  await page.evaluate(() => window._cellucidHistories.current().undo());
  await expect.poll(() => viewNames(page)).toEqual([null, 'Early', 'Late']);
  await expect.poll(() => readRows(page)).toEqual([
    { number: '1', name: null },
    { number: '2', name: 'Early' },
    { number: '3', name: 'Late' },
  ]);
  await page.evaluate(() => window._cellucidHistories.current().redo());
  await expect.poll(() => viewNames(page)).toEqual(['Base', 'Early', 'Late']);

  // A step on a named view says its name.
  expect(await dispatch(page, 'view.focus', { view: 'View 2' })).toEqual({ outcome: { view: 'View 2', label: 'Early' } });
  expect(await lastLabel(page)).toBe('Selected View 2 "Early"');
  await expect(page.locator('#view-representation-label')).toHaveText(/^View 2 "Early" shows$/);

  // The views read names them beside their numbers.
  const read = await dispatch(page, 'views.state', {});
  expect(read.outcome.views.map(view => [view.name, view.label])).toEqual([['View 1', 'Base'], ['View 2', 'Early'], ['View 3', 'Late']]);

  // A figure of every view: each panel is titled by its view's name, and the provenance says it.
  const figure = await gridFigure(page);
  for (const title of ['A. Base', 'B. Early', 'C. Late']) expect(figure.svg).toContain(`>${title}</text>`);
  expect(figure.provenance.views.map(view => [view.panel, view.name])).toEqual([['A', 'Base'], ['B', 'Early'], ['C', 'Late']]);
  expect(figure.filename).toContain('multiview');

  // A saved session keeps the names; loading it puts them back after they were changed.
  const downloadPromise = page.waitForEvent('download');
  await clickSaveSession(page);
  const sessionPath = testInfo.outputPath('named-views.cellucid-session');
  await (await downloadPromise).saveAs(sessionPath);
  expect(await dispatch(page, 'view.rename', { view: 'View 2', name: null })).toEqual({ outcome: { view: 'View 2', was: 'Early' } });
  expect(await lastLabel(page)).toBe('Took the name off View 2 "Early"');
  expect(await viewNames(page)).toEqual(['Base', null, 'Late']);
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles(sessionPath);
  await expect.poll(() => viewNames(page)).toEqual(['Base', 'Early', 'Late']);
  await expect.poll(() => readRows(page)).toEqual([
    { number: '1', name: 'Base' },
    { number: '2', name: 'Early' },
    { number: '3', name: 'Late' },
  ]);
  await page.screenshot({ path: testInfo.outputPath('view-names-after-session-load.png') });

  expect(errors).toEqual([]);
});
