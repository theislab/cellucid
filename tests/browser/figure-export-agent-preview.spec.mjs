/**
 * An agent's figure, checked before it is written (bug hunt live pass 6).
 *
 * L24-1: preparing a paper's Figure 2, an agent could only take plain
 * pictures of single views and told the person three times "my previews
 * don't show the export settings, please check the file". `view.picture`
 * with `source: "export"` is the figure Export would write now, with every
 * Figure export setting, every view as panels: the same renderer and the
 * same size as the download, nothing written.
 *
 * L24-7: Export refused with "Value must be less than or equal to 24" (the
 * base font size an agent had set to 28, which the control's own max
 * marked invalid while the reader and `figure-export.set` allow 1–500)
 * when what refused was another control; the agent shrank the person's
 * fonts for nothing. One range per text size, and a refusal names the
 * control that refused.
 *
 * F160: an SVG is full vector until another strategy is chosen, so Export
 * never refuses one for want of a choice.
 *
 * F271 (live-7 L25-10): the figure's width is set in millimetres and filled
 * exactly, its text in points; the picture says the printed size, and a PNG
 * at D dpi is the width in inches times D.
 */
import { readFileSync } from 'node:fs';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { decodePng } from './helpers/png-pixels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=figure-export-agent-preview`;

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

function dispatch(page, type, params = {}) {
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

/** The Figure export section and its Framing group open, as a person opens them. */
async function openFraming(page) {
  if ((await page.locator('#figure-export-section').getAttribute('open')) === null) {
    await page.locator('#figure-export-section > summary').click();
  }
  await expect(page.locator('#figure-export-section')).toHaveAttribute('open', '');
  const framing = page.getByRole('button', { name: /^Framing\b/ });
  if ((await framing.getAttribute('aria-expanded')) !== 'true') await framing.click();
  await expect(framing).toHaveAttribute('aria-expanded', 'true');
}

async function openThreeNamedViews(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  expect((await dispatch(page, 'view.keep', { name: 'Cell types' })).refused).toBeUndefined();
  expect((await dispatch(page, 'view.keep', { name: 'Neurog3 (endocrine progenitor), the switch into the lineage' })).refused).toBeUndefined();
  await expect(page.locator('.view-title-chip')).toHaveCount(3);
}

test('an "export" picture is the figure Export writes: its settings, every view, the same size; nothing written', async ({ page }) => {
  const errors = observeProductErrors(page);
  const downloads = [];
  page.on('download', download => downloads.push(download));
  await openThreeNamedViews(page);

  expect((await dispatch(page, 'figure-export.set', {
    export_all_views: true, background: 'white', reference_grid: false, include_axes: false, include_legend: true,
    auto_text_size: false, font_sizes: { base: 21, legend: 16.5, ticks: 12, axis_label: 15, title: 22.5, centroid_label: 13.5 },
    title_follows_dataset: false, title: 'Figure 2', width: 423, download: 'png', dpi: 300,
  })).refused).toBeUndefined();
  // A width that is no preset's is a custom width.
  expect((await dispatch(page, 'figure-export.get')).outcome.size_preset).toBe('custom');
  // A size an agent sets is a size its control holds: nothing in the panel is left invalid (L24-7).
  expect(await page.locator('#figure-export-section :invalid').count()).toBe(0);

  const { outcome: picture } = await dispatch(page, 'view.picture', { source: 'export', width: 5000, height: 5000 });
  expect(picture.view).toBeNull();
  expect(picture.plot).toBeNull();
  // Its printed size: exactly the 423 mm asked (1599 figure pixels, 1/96 inch).
  expect(picture.notes[0]).toMatch(/^The figure is 423 × \d+ mm as printed .*a PNG at 300 dpi is 4997 × \d+ px/);
  const size = /^The picture is the figure at 96 dpi \((\d+) × (\d+) px\)/.exec(picture.notes[2]);
  expect(size).not.toBeNull();
  expect(Number(size[1])).toBe(1599);
  // Never enlarged: a box larger than the figure returns the figure as drawn.
  expect([picture.width, picture.height]).toEqual([Number(size[1]), Number(size[2])]);
  const decoded = decodePng(Buffer.from(picture.png, 'base64'));
  expect([decoded.width, decoded.height]).toEqual([picture.width, picture.height]);
  // The white background asked for, at the corner (the viewer's is not white).
  expect([...decoded.pixels.subarray(0, 3)]).toEqual([255, 255, 255]);
  expect(downloads).toHaveLength(0);

  // Scaled down into a smaller box, its shape kept.
  const { outcome: small } = await dispatch(page, 'view.picture', { source: 'export', width: 800, height: 800 });
  expect(small.width).toBeLessThanOrEqual(800);
  expect(small.height).toBeLessThanOrEqual(800);
  expect(small.width / small.height).toBeCloseTo(picture.width / picture.height, 1);
  expect(small.notes[2]).toMatch(/shown at \d+% \(\d+ × \d+\)\.$/);

  // The download at 300 dpi is the same figure: 300 / 96 times its pixels, 423 mm wide.
  const downloaded = page.waitForEvent('download');
  expect((await dispatch(page, 'figure.export')).refused).toBeUndefined();
  const file = await downloaded;
  const written = decodePng(readFileSync(await file.path()));
  expect(Math.abs(written.width - picture.width * 300 / 96)).toBeLessThanOrEqual(2);
  expect(Math.abs(written.height - picture.height * 300 / 96)).toBeLessThanOrEqual(2);

  // A view named with "export" is refused with what to do.
  expect((await dispatch(page, 'view.picture', { source: 'export', view: 'View 2' })).refused)
    .toMatch(/draws what Export would download .*leave view out/);
  expect(errors).toEqual([]);
});

test('Export refused names the control that refused, not another one', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openThreeNamedViews(page);
  expect((await dispatch(page, 'figure-export.set', {
    auto_text_size: false, font_sizes: { base: 21, legend: 16.5, ticks: 12, axis_label: 15, title: 22.5, centroid_label: 13.5 },
    download: 'svg',
  })).refused).toBeUndefined();
  // An SVG asks no strategy first: full vector (F160).
  await expect(page.getByLabel('SVG point strategy')).toHaveValue('full-vector');
  expect((await dispatch(page, 'figure-export.get')).outcome.svg_strategy).toBe('full-vector');
  // The person half-way through typing a width: that box refuses, and the refusal says so.
  await openFraming(page);
  await page.locator('#figure-export-width').fill('5');
  const refused = (await dispatch(page, 'figure.export')).refused;
  expect(refused).toBe('The figure export settings are not valid: Figure width (mm) must be at least 10; figure_export_set changes them.');
  // The fonts were never the problem: their controls hold 21 pt.
  await expect(page.locator('#figure-export-font-size')).toHaveValue('21');
  expect(await page.locator('#figure-export-font-size').evaluate(input => input.validity.valid)).toBe(true);
  // With a width the export can use, it is written as a full-vector SVG, its size in millimetres.
  await page.locator('#figure-export-width').fill('160');
  const downloaded = page.waitForEvent('download');
  expect((await dispatch(page, 'figure.export')).refused).toBeUndefined();
  const svgFile = await downloaded;
  expect(svgFile.suggestedFilename()).toMatch(/\.svg$/);
  // Its size in millimetres, the viewBox in figure pixels (1/96 inch): at least the 160 mm asked
  // (text this large, 21 pt, makes it wider, as the export picture would say).
  const root = /^<svg[^>]* width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 (\d+) (\d+)"/.exec(readFileSync(await svgFile.path(), 'utf8'));
  expect(root).not.toBeNull();
  expect(Math.abs(Number(root[1]) - Number(root[3]) * 25.4 / 96)).toBeLessThan(0.001);
  expect(Math.abs(Number(root[2]) - Number(root[4]) * 25.4 / 96)).toBeLessThan(0.001);
  expect(Number(root[3])).toBeGreaterThanOrEqual(605);
  expect(errors).toEqual([]);
});

test('Fit the cells frames every cell drawn: a narrow pane gives a plot of the cells\' shape, said and offered by the preview (F161, F119)', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  // A tall, narrow pane (as with the chat open): the figure keeps it (F62), a tall figure with
  // the (about square) cells in a band, far (1.5 times or more) from their shape.
  await page.setViewportSize({ width: 700, height: 1300 });
  await openFraming(page);
  expect((await dispatch(page, 'figure-export.set', {
    size_preset: 'double-column', preview: { enabled: true, colorblind_mode: 'none' },
  })).refused).toBeUndefined();
  const before = (await dispatch(page, 'view.picture', { source: 'export', width: 1200, height: 1200 })).outcome.plot;
  expect(before.width / before.height).toBeLessThan(1);

  // The preview says so in one line and offers the framing.
  const note = page.locator('.figure-export-shape-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Plot narrower than the cells:');
  await note.getByRole('button', { name: 'Fit the cells' }).click();
  await expect(note).toBeHidden();
  const fitted = (await dispatch(page, 'figure-export.get')).outcome;
  expect(fitted.frame.lock_aspect).toBe(false);
  expect(fitted.preview.enabled).toBe(true);
  const after = (await dispatch(page, 'view.picture', { source: 'export', width: 1200, height: 1200 })).outcome.plot;
  // The cells' shape (the fixture's are about square): the same width, a shorter figure.
  expect(after.width / after.height).toBeGreaterThan(1.15 * (before.width / before.height));
  expect(after.height).toBeLessThan(before.height);

  // An agent's one value does the same: frame "cells" makes the frame the button made.
  expect((await dispatch(page, 'figure-export.set', { frame: null })).refused).toBeUndefined();
  await expect(note).toBeVisible();
  expect((await dispatch(page, 'figure-export.set', { frame: 'cells' })).refused).toBeUndefined();
  expect((await dispatch(page, 'figure-export.get')).outcome.frame).toEqual(fitted.frame);
  await expect(note).toBeHidden();
  expect(errors).toEqual([]);
});

test('settings saved by an earlier version restore one at a time: a value this version cannot use stays as shown and is said, never failing the rest', async ({ page }) => {
  // Found 2026-11-11: the figure export record's version 1 (an SVG strategy not chosen, null)
  // failed every setting of an hour-old session and of a dataset's starting view.
  const errors = observeProductErrors(page);
  await openThreeNamedViews(page);
  const outcome = await page.evaluate(async () => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const settings = getStateDomains().owner('settings');
    const saved = structuredClone(await settings.capture());
    // A version-1 record: a box in CSS pixels (1600 wide is 423.3 mm), no strategy chosen.
    saved.figureExport = { ...saved.figureExport, version: 1, svgStrategy: null, sizePreset: '1600x1200', width: 1600, height: 1200, dpi: 299 };
    saved.controls['a-control-of-another-version'] = { type: 'checkbox', checked: true };
    await settings.restore(saved);
    return (await getActions().dispatch('figure-export.get', {})).outcome;
  });
  // Read: the width; mapped: the unchosen strategy is full vector; kept as shown: the dpi no version has.
  expect(outcome.width).toBe(423.3);
  expect(outcome.size_preset).toBe('custom');
  expect(outcome.svg_strategy).toBe('full-vector');
  expect(outcome.dpi).toBe(300);
  const notice = page.locator('.notification', { hasText: '2 saved settings could not be used and stay as shown' });
  await expect(notice).toBeVisible();
  // Each, with its reason, under Details.
  await expect(notice).toContainText('a-control-of-another-version: this version of Cellucid has no such control');
  await expect(notice).toContainText('Figure export dpi: dpi must be one of 150, 300, 600.');
  expect(errors).toEqual([]);
});
