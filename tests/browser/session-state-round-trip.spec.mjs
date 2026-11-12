/**
 * A session must come back whole, not almost whole (CEL-0232).
 *
 * Every existing session test names what it checks: four renderer controls,
 * eleven filter properties, one active field, a theme and a point size. That is
 * the same shape as the defect this subsystem keeps producing — state
 * republished from a hand-maintained list, and the list drifts. A control added
 * to the app is covered by none of those tests until somebody remembers to add
 * an assertion for it.
 *
 * This spec names nothing. It builds a rich state in the real application,
 * saves it, drifts every part of it, loads the file back, saves again, and
 * compares the two captures **whole**. The captures are what the running app
 * says its state is — re-derived from the live DOM, `DataState`, and the viewer
 * at each save — so a difference means a real restore failure, not a byte
 * difference in a container. A control that stops restoring fails this spec the
 * day it stops, whether or not anyone updated a list.
 *
 * The captures are every state domain's value (`app/state/domains/`), the
 * same values a session file holds and the history steps between, compared
 * domain by domain by their content hashes (and whole, for a readable
 * difference). A kept view is named by its position in them, never by the
 * viewer's own `snap_<n>` id, so views rebuilt by a restore compare equal.
 *
 * The state it builds deliberately includes a **highlight group with cell
 * membership**, a kept view, a second highlight page, controls from four
 * different accordions, the theme and the Figure export settings; and a
 * non-default selection tool, page chrome a session carries outside its
 * history. It is drifted partly through the interface and partly behind the
 * history's back (state methods called directly): a save keeps what is shown
 * either way, as its own step.
 */

import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=session-round-trip-ci';

/**
 * Every state domain's value now, with its content hash: the whole state the
 * running app says it has, re-derived from the live DOM, `DataState` and the
 * viewer. Typed arrays come back as plain arrays, so a membership that came
 * back permuted or truncated is a visible difference.
 */
function domainState(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { captureEveryDomain, fingerprintOf } = await import('/assets/js/app/state/domains/fingerprint.js');
    const values = await captureEveryDomain(getStateDomains());
    const { domains: hashes } = await fingerprintOf(values);
    const plain = JSON.parse(JSON.stringify(values, (_key, value) => (ArrayBuffer.isView(value) ? Array.from(value) : value)));
    return { hashes, values: plain };
  });
}

/**
 * Set one control the way its owner hears about it.
 *
 * Several serialized controls sit in collapsed accordions or in containers the
 * renderer panel hides — `#hp-lod-force` is revealed only when adaptive LOD is
 * off — so a pointer-driven `fill()` cannot reach them from a fresh page. This
 * writes the value and dispatches the same event `ui-controls.js` dispatches,
 * which is the real publication path: the owner's listener runs, and a control
 * that rejects the value still rejects it here.
 */
async function setControl(page, id, value) {
  await page.evaluate(([controlId, controlValue]) => {
    const element = document.getElementById(controlId);
    if (element === null) throw new Error(`no control #${controlId}`);
    if (element.type === 'checkbox') {
      element.checked = controlValue;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    element.value = String(controlValue);
    element.dispatchEvent(new Event(
      element.tagName === 'SELECT' ? 'change' : 'input',
      { bubbles: true },
    ));
  }, [id, value]);
}

async function saveSession(page, testInfo, name) {
  const downloadPromise = page.waitForEvent('download');
  await clickSaveSession(page);
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(name);
  await download.saveAs(sessionPath);
  return sessionPath;
}

async function loadSession(page, sessionPath) {
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);
}

test('a saved session restores to the exact state it recorded', async (
  { page },
  testInfo,
) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  // ---------------------------------------------------------------------
  // Build a state worth saving.
  // ---------------------------------------------------------------------
  const categorical = page.locator('#categorical-field');
  await categorical.selectOption({ label: 'cell_type' });
  await expect(categorical.locator('option:checked')).toHaveText('cell_type');

  // Two highlight pages, with real cell membership on each. `addHighlightFrom*`
  // are the same DataState entry points the legend and the range controls call;
  // driving them directly keeps the spec about persistence rather than about
  // the geometry of a lasso gesture.
  // Selecting the field starts an asynchronous load; a category highlight needs
  // the codes, so wait for them rather than for a frame count.
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    if (state.activeFieldSource !== 'obs' || state.activeFieldIndex < 0) {
      return null;
    }
    const field = state.obsData.fields[state.activeFieldIndex];
    return field?.key === 'cell_type' && field.codes != null
      ? field.codes.length
      : null;
  })).toBe(120);

  const built = await page.evaluate(() => {
    const state = window._cellucidState;
    const fieldIndex = state.activeFieldIndex;
    const first = state.addHighlightFromCategory(fieldIndex, 0, 'obs');
    const second = state.addHighlightFromCategory(fieldIndex, 1, 'obs');
    const page2 = state.createHighlightPage();
    state.switchToPage(page2.id);
    const third = state.addHighlightDirect({
      type: 'lasso',
      label: 'Hand drawn region',
      cellIndices: Uint32Array.of(3, 11, 12, 40, 41, 42, 97),
    });
    state.setHighlightPageColor(page2.id, '#ff8800');
    state.renameHighlightPage(page2.id, 'Region of interest');
    // `toggleHighlightEnabled` is a setter despite its name: the second
    // argument is required and is written to `group.enabled` unvalidated.
    state.toggleHighlightEnabled(third.id, false);
    state.switchToPage(state.highlightPages[0].id);
    return {
      groups: [first, second, third].map(group => group.id),
      counts: [first, second, third].map(group => group.cellCount),
    };
  });
  expect(
    built.groups.length,
    'the spec must actually create highlight groups, or the membership path '
      + 'it exists to exercise is never reached',
  ).toBe(3);
  expect(Math.min(...built.counts)).toBeGreaterThan(0);

  // A non-default selection tool: page chrome, which a session carries outside its
  // history (its `chrome`, CEL-0249), never as a setting.
  await page.locator('#highlight-mode-lasso').click();
  await expect(page.locator('#highlight-mode-lasso'))
    .toHaveAttribute('aria-pressed', 'true');

  // Controls from several accordions, including two the renderer owns and one
  // that is only reachable once adaptive LOD is off.
  await page.locator('#point-size').fill('31');
  await page.locator('#point-size').dispatchEvent('input');
  await page.locator('#background-select').selectOption('black');
  // The app theme travels with a session (the antialiasing preference, a
  // device capability, does not).
  await page.locator('#theme-select').selectOption('dark');
  await setControl(page, 'hp-lod-enabled', false);
  // A forced level of the ladder of the cells open (draw-order.js
  // `lodLadder`): this dataset's 120 cells have one level, 0, and -1 is Auto.
  await setControl(page, 'hp-lod-force', '0');
  await setControl(page, 'hp-frustum-culling', false);
  await setControl(page, 'toggle-centroid-labels', true);
  await setControl(page, 'smoke-density', '71');
  await expect(page.locator('#hp-lod-force')).toHaveValue('0');

  // Figure-export settings: the panel is outside the generic control
  // inventory, so its own record is what the session carries.
  const figureDefaults = await page.evaluate(() => {
    const panel = window._cellucidUi.figureExport;
    const defaults = panel.exportSessionSettings();
    panel.importSessionSettings({
      ...defaults,
      // A width of one's own, in millimetres (the figure fills it at its own height).
      sizePreset: 'custom',
      width: 150.5,
      xLabel: 'UMAP one',
      dpi: 600,
    });
    return defaults;
  });

  // A kept view, so multiview is inside the comparison.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('#split-view-badges-list > *')).not.toHaveCount(0);

  const saved = await domainState(page);
  const savedPath = await saveSession(page, testInfo, 'saved.cellucid-session');

  // The saved state has to contain the things this spec claims to cover;
  // otherwise the comparison below could be satisfied by two empty states.
  const { highlights, settings, layout, views } = saved.values;
  expect(highlights.pages, 'two highlight pages').toHaveLength(2);
  expect(highlights.pages.flatMap(entry => entry.groups)).toHaveLength(3);
  expect(
    highlights.pages.flatMap(entry => entry.groups).every(group => group.cells.length > 0),
    'every highlight group holds its cells: the membership no published preset carries',
  ).toBe(true);
  expect(layout.theme).toBe('dark');
  expect(Object.hasOwn(settings.controls, 'hp-antialias')).toBe(false);
  expect(settings.figureExport).toMatchObject({ sizePreset: 'custom', width: 150.5, xLabel: 'UMAP one', dpi: 600 });
  expect(Object.hasOwn(settings.controls, 'highlight-mode')).toBe(false);
  expect(views.views.length).toBeGreaterThan(1);

  // ---------------------------------------------------------------------
  // Drift past the saved state, in every part of it.
  // ---------------------------------------------------------------------
  await page.locator('#highlight-mode-annotation').click();
  await page.locator('#point-size').fill('7');
  await page.locator('#point-size').dispatchEvent('input');
  await setControl(page, 'hp-lod-force', '-1');
  await setControl(page, 'hp-lod-enabled', true);
  await setControl(page, 'hp-frustum-culling', true);
  await page.locator('#background-select').selectOption('white');
  await page.locator('#theme-select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.evaluate(defaults => {
    window._cellucidUi.figureExport.importSessionSettings(defaults);
  }, figureDefaults);
  await setControl(page, 'toggle-centroid-labels', false);
  await setControl(page, 'smoke-density', '20');
  await page.evaluate(() => {
    const state = window._cellucidState;
    state.clearActivePageHighlights();
    for (const highlightPage of [...state.highlightPages].slice(1)) {
      state.deleteHighlightPage(highlightPage.id);
    }
    state.clearActiveField();
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    viewer.setCameraState({
      ...camera,
      orbit: { ...camera.orbit, radius: camera.orbit.radius * 1.7 },
    });
  });

  await expect(page.locator('#point-size')).toHaveValue('7');
  await expect(page.locator('#highlight-mode-annotation'))
    .toHaveAttribute('aria-pressed', 'true');

  // ---------------------------------------------------------------------
  // Restore, then ask the application what its state is now.
  // ---------------------------------------------------------------------
  await loadSession(page, savedPath);

  await expect(page.locator('#point-size')).toHaveValue('31');
  // The tool chosen when it was saved comes back with it, once its head is shown.
  await expect(page.locator('#highlight-mode-lasso'))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#categorical-field option:checked'))
    .toHaveText('cell_type');
  // The restored theme goes through the same owner as a choice made by hand:
  // the page shows it and the stored preference agrees.
  await expect(page.locator('#theme-select')).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('cellucid_theme')))
    .toBe('dark');

  // ---------------------------------------------------------------------
  // Compare the two captures whole, domain by domain.
  // ---------------------------------------------------------------------
  await waitForHistory(page);
  const restored = await domainState(page);
  for (const id of Object.keys(saved.hashes)) {
    expect(restored.values[id], `the "${id}" state must come back exactly`).toEqual(saved.values[id]);
  }
  expect(restored.hashes, 'every state domain comes back, to its content hash').toEqual(saved.hashes);

  // ---------------------------------------------------------------------
  // A restore raises nothing (CEL-0239).
  //
  // This assertion used to carry a named exemption for exactly one uncaught
  // `RangeError` per restore. A restore of the views emptied the viewer's
  // snapshot inventory at the start of the rebuild, and
  // `ui/modules/view-controls.js` kept private
  // `activeViewId` and `liveViewHidden` copies of state its owners had already
  // moved. The badge render that the same rebuild scheduled then threw on a
  // kept view that no longer existed. The module now reads both from their
  // owners on every use, so there is nothing left to exempt.
  //
  // The exemption mattered because `state-serializer/ui-controls.js` installs a
  // capture-phase window `error` listener for the duration of each control
  // event it dispatches: a badge render reached synchronously from a restored
  // control's own listener turned this into a restore failure naming an
  // unrelated control.
  expect(
    browserErrors,
    'no session restore may raise a page error',
  ).toEqual([]);
});

test('a session saved while a view is colored by a continuous field loads back', async (
  { page },
  testInfo,
) => {
  // The continuous legend rebuilds its range sliders with generated ids on
  // every render. A session that recorded those ids named controls no fresh
  // page has, and loading it was refused ("Session UI control … does not
  // exist"). What the sliders show is the field's own filter and color
  // range, which the core state saves; the legend is not a control inventory.
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect(page.locator('#legend input[type="range"]').first()).toBeAttached();
  const sessionPath = await saveSession(page, testInfo, 'continuous-legend.cellucid-session');

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await loadSession(page, sessionPath);
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    const field = state.activeFieldSource === 'obs'
      ? state.obsData.fields[state.activeFieldIndex]
      : null;
    return field?.key ?? null;
  })).toBe('score');
  await expect(page.locator('.notification', { hasText: /does not exist|could not|failed/i })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
