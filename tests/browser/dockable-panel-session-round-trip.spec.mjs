import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

/* The floating panels in the `layout` state domain's value
   (`app/state/domains/layout.js`): what it records is what a restore (a
   history step shown, a session) gets back. Three of the things it records
   used to be read from the wrong owner, and each of them is only observable
   against real CSS:

   - the panel's size was measured off the rendered box, and
     `_accordion.css` forces `height: auto` on a collapsed floating panel, so
     collapsing one before saving threw away the size it reopens at;
   - the stacking order was assigned from a counter private to
     `dockable-accordions.js`, which a restore wrote past — so a panel torn
     off after a restore opened underneath the restored ones (the value holds
     no stacking order now: raising a panel is not a step);
   - a restored panel was floated through the entry point analysis windows use,
     which leaves no placeholder, so docking it dropped it at the end of the
     sidebar instead of back in its own place.

   The unit contract exercises the same three against a fake DOM. This runs them
   through the real modules, the real stylesheet and the real layout engine. */

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=dockable-panel-session-round-trip-ci`;

/** Panels that are session-owned (no `data-state-serializer-skip`). */
const FIRST_PANEL = 'visualization-section';
const SECOND_PANEL = 'coloring-filtering-section';
const THIRD_PANEL = 'compare-views-section';

async function openPreparedDataset(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture'
  );
}

/** The frame a panel stands in: the element that floats and carries its controls. */
function panelFrame(page, panelId) {
  return page.locator(`.accordion-panel:has(> #${panelId})`);
}

function headerControl(page, panelId, className) {
  return panelFrame(page, panelId).locator(
    `> .accordion-panel-actions > .${className}`
  );
}

async function undockFromHeader(page, panelId) {
  const button = headerControl(page, panelId, 'accordion-undock-btn');
  await expect(button).toBeVisible();
  await button.click();
  await expect(panelFrame(page, panelId)).toHaveClass(/accordion-floating/);
}

/** The `layout` domain's value now. */
function captureLayout(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    return getStateDomains().owner('layout').capture();
  });
}

/** Put a `layout` value back through its owner, as a history step shown does. */
function restoreLayout(page, value) {
  return page.evaluate(async layout => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    await getStateDomains().owner('layout').restore(layout, { signal: null });
  }, value);
}

function panelLayer(page, panelId) {
  return page.evaluate((id) => {
    const frame = document.getElementById(id)?.parentElement ?? null;
    if (frame === null || !frame.classList.contains('accordion-panel')) {
      throw new Error(`Panel ${id} is not standing in its frame`);
    }
    const raw = getComputedStyle(frame).getPropertyValue('--z-layer').trim();
    return raw === '' ? null : Number(raw);
  }, panelId);
}

function sidebarPanelOrder(page) {
  return page.evaluate(() => {
    const accordion = document.querySelector('#sidebar .accordion');
    if (accordion === null) throw new Error('Sidebar accordion is absent');
    return [...accordion.children]
      .filter(child => child.matches('.accordion-panel'))
      .map(child => child.querySelector(':scope > details.accordion-section').id);
  });
}

function setPanelOpen(page, panelId, open) {
  return page.evaluate(({ id, value }) => {
    const panel = document.getElementById(id);
    if (panel === null) throw new Error(`Panel ${id} is absent`);
    panel.open = value;
  }, { id: panelId, value: open });
}

test('a floating layout captured from the live DOM restores to itself', async ({
  page,
}) => {
  await openPreparedDataset(page);

  const dockedOrder = await sidebarPanelOrder(page);
  expect(dockedOrder).toContain(FIRST_PANEL);
  expect(dockedOrder).toContain(SECOND_PANEL);

  await undockFromHeader(page, FIRST_PANEL);
  await undockFromHeader(page, SECOND_PANEL);

  const first = await captureLayout(page);
  expect(first.panels.map(panel => panel.id)).toEqual([FIRST_PANEL, SECOND_PANEL].sort());
  for (const panel of first.panels) {
    expect(Object.keys(panel).sort()).toEqual(['id', 'rect']);
    expect(panel.rect.width).toBeGreaterThan(0);
    expect(panel.rect.height).toBeGreaterThan(0);
  }

  // Docked again, then restored: the same panels float at the same boxes.
  await headerControl(page, FIRST_PANEL, 'accordion-dock-btn').click();
  await headerControl(page, SECOND_PANEL, 'accordion-dock-btn').click();
  expect((await captureLayout(page)).panels).toEqual([]);
  await restoreLayout(page, first);
  const second = await captureLayout(page);
  expect(second).toEqual(first);
  // Restoring what is shown changes nothing.
  await restoreLayout(page, second);
  expect(await captureLayout(page)).toEqual(first);
});

test('a panel collapsed before the capture reopens at its own height', async ({
  page,
}) => {
  await openPreparedDataset(page);
  await undockFromHeader(page, FIRST_PANEL);

  const open = await captureLayout(page);
  const openHeight = open.panels[0].rect.height;
  expect(openHeight).toBeGreaterThan(100);

  /* `_accordion.css`:
     `.accordion-panel.accordion-floating:has(> .accordion-section:not([open]))
      { height: auto }` —
     so the rendered box is now the header, and the panel's own height is not. */
  await setPanelOpen(page, FIRST_PANEL, false);
  const renderedHeight = await panelFrame(page, FIRST_PANEL).evaluate(
    frame => frame.getBoundingClientRect().height
  );
  expect(renderedHeight).toBeLessThan(openHeight);

  const collapsed = await captureLayout(page);
  expect(collapsed.sections[FIRST_PANEL]).toBe(false);
  expect(collapsed.panels[0].rect.height).toBe(openHeight);

  // Docked and opened, then the collapsed layout restored: it floats collapsed, at its own height.
  await headerControl(page, FIRST_PANEL, 'accordion-dock-btn').click();
  await setPanelOpen(page, FIRST_PANEL, true);
  await restoreLayout(page, collapsed);
  /* Floating a panel opens it; whether it is open is one fact of the value
     (`sections`), put back after the panels float. */
  const restored = await captureLayout(page);
  expect(restored.sections[FIRST_PANEL]).toBe(false);
  expect(restored.panels[0].rect.height).toBe(openHeight);

  await setPanelOpen(page, FIRST_PANEL, true);
  const reopened = await captureLayout(page);
  expect(reopened.panels[0].rect.height).toBe(openHeight);
});

test('a panel torn off after a restore opens above the restored panels', async ({
  page,
}) => {
  await openPreparedDataset(page);
  await undockFromHeader(page, FIRST_PANEL);
  await undockFromHeader(page, SECOND_PANEL);

  const captured = await captureLayout(page);
  // Docked again, then floated back by a restore.
  await headerControl(page, FIRST_PANEL, 'accordion-dock-btn').click();
  await headerControl(page, SECOND_PANEL, 'accordion-dock-btn').click();
  await restoreLayout(page, captured);
  const restoredLayers = await Promise.all([
    panelLayer(page, FIRST_PANEL),
    panelLayer(page, SECOND_PANEL),
  ]);
  expect(restoredLayers.every(layer => Number.isSafeInteger(layer))).toBe(true);

  await undockFromHeader(page, THIRD_PANEL);
  const thirdLayer = await panelLayer(page, THIRD_PANEL);
  expect(thirdLayer).toBeGreaterThan(Math.max(...restoredLayers));
  // Which panel is in front is not part of the value: raising one is not a change.
  expect((await captureLayout(page)).panels.map(panel => panel.id)).toEqual([FIRST_PANEL, SECOND_PANEL, THIRD_PANEL].sort());
});

test('a restored panel docks back into its own place in the sidebar', async ({
  page,
}) => {
  await openPreparedDataset(page);
  const dockedOrder = await sidebarPanelOrder(page);

  await undockFromHeader(page, SECOND_PANEL);
  const captured = await captureLayout(page);
  await headerControl(page, SECOND_PANEL, 'accordion-dock-btn').click();

  /* Restoring re-floats a panel that is standing in the sidebar. */
  await restoreLayout(page, captured);
  await expect(panelFrame(page, SECOND_PANEL)).toHaveClass(
    /accordion-floating/
  );

  await headerControl(page, SECOND_PANEL, 'accordion-dock-btn').click();
  await expect(panelFrame(page, SECOND_PANEL)).not.toHaveClass(
    /accordion-floating/
  );

  expect(await sidebarPanelOrder(page)).toEqual(dockedOrder);
});
