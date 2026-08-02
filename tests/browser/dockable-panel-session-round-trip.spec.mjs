import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

/* The floating-panel layout is one of the five chunks a published preset may
   carry (`session/published-default.js`), so what it records is what a reader
   gets back. Three of the things it records used to be read from the wrong
   owner, and each of them is only observable against real CSS:

   - the panel's size was measured off the rendered box, and
     `_accordion.css` forces `height: auto` on a collapsed floating panel, so
     collapsing one before saving threw away the size it reopens at;
   - the stacking order was assigned from a counter private to
     `dockable-accordions.js`, which a restore writes past — so a panel torn
     off after a restore opened underneath the restored ones;
   - a restored panel was floated through the entry point analysis windows use,
     which leaves no placeholder, so docking it dropped it at the end of the
     sidebar instead of back in its own place.

   The unit contract exercises the same three against a fake DOM. This runs them
   through the real modules, the real stylesheet and the real layout engine. */

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=dockable-panel-session-round-trip-ci`;

const DOCKABLE_REGISTRY_URL = '/assets/js/app/dockable-accordions-registry.js';
const DOCKABLE_CONTRIBUTOR_URL =
  '/assets/js/app/session/contributors/dockable-layout.js';

/** Panels that are session-owned (no `data-state-serializer-skip`). */
const FIRST_PANEL = 'visualization-section';
const SECOND_PANEL = 'coloring-filtering-section';
const THIRD_PANEL = 'compare-views-section';

async function openPreparedDataset(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
}

async function undockFromHeader(page, panelId) {
  const button = page.locator(`#${panelId} > summary .accordion-undock-btn`);
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator(`#${panelId}`)).toHaveClass(
    /accordion-floating/
  );
}

function captureLayout(page) {
  return page.evaluate(async ({ registryUrl, contributorUrl }) => {
    const { getDockableAccordions } = await import(registryUrl);
    const contributor = await import(contributorUrl);
    const chunks = contributor.capture({
      dockableAccordions: getDockableAccordions(),
    });
    return chunks[0];
  }, {
    registryUrl: DOCKABLE_REGISTRY_URL,
    contributorUrl: DOCKABLE_CONTRIBUTOR_URL,
  });
}

function restoreLayout(page, payload) {
  return page.evaluate(async ({ registryUrl, contributorUrl, value }) => {
    const { getDockableAccordions } = await import(registryUrl);
    const contributor = await import(contributorUrl);
    contributor.restore(
      { dockableAccordions: getDockableAccordions() },
      null,
      value
    );
  }, {
    registryUrl: DOCKABLE_REGISTRY_URL,
    contributorUrl: DOCKABLE_CONTRIBUTOR_URL,
    value: payload,
  });
}

function panelLayer(page, panelId) {
  return page.evaluate((id) => {
    const panel = document.getElementById(id);
    if (panel === null) throw new Error(`Panel ${id} is absent`);
    const raw = getComputedStyle(panel).getPropertyValue('--z-layer').trim();
    return raw === '' ? null : Number(raw);
  }, panelId);
}

function sidebarPanelOrder(page) {
  return page.evaluate(() => {
    const accordion = document.querySelector('#sidebar .accordion');
    if (accordion === null) throw new Error('Sidebar accordion is absent');
    return [...accordion.children]
      .filter(child => child.matches('details.accordion-section'))
      .map(child => child.id);
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
  expect(first.id).toBe('ui/dockable-layout');
  expect(first.contributorId).toBe('dockable-layout');
  expect(first.codec).toBe('gzip');
  expect(first.payload.panels.map(panel => panel.id).sort()).toEqual(
    [FIRST_PANEL, SECOND_PANEL].sort()
  );
  for (const panel of first.payload.panels) {
    expect(panel.rect.width).toBeGreaterThan(0);
    expect(panel.rect.height).toBeGreaterThan(0);
  }

  await restoreLayout(page, first.payload);
  const second = await captureLayout(page);
  expect(second.payload).toEqual(first.payload);
});

test('a panel collapsed before the capture reopens at its own height', async ({
  page,
}) => {
  await openPreparedDataset(page);
  await undockFromHeader(page, FIRST_PANEL);

  const open = await captureLayout(page);
  const openHeight = open.payload.panels[0].rect.height;
  expect(openHeight).toBeGreaterThan(100);

  /* `_accordion.css`:
     `.accordion-section.accordion-floating:not([open]) { height: auto }` —
     so the rendered box is now the header, and the panel's own height is not. */
  await setPanelOpen(page, FIRST_PANEL, false);
  const renderedHeight = await page.locator(`#${FIRST_PANEL}`).evaluate(
    panel => panel.getBoundingClientRect().height
  );
  expect(renderedHeight).toBeLessThan(openHeight);

  const collapsed = await captureLayout(page);
  expect(collapsed.payload.panels[0].open).toBe(false);
  expect(collapsed.payload.panels[0].rect.height).toBe(openHeight);

  await restoreLayout(page, collapsed.payload);
  /* A panel saved collapsed must come back collapsed. This is worth asserting
     separately from the geometry because two contributors record this one fact:
     `state-serializer/ui-controls.js` walks the floating root too, so the panel
     is also recorded as `accordion:<id>`, and whichever restores second wins.
     They agree today; nothing made them. */
  const restored = await captureLayout(page);
  expect(restored.payload.panels[0].open).toBe(false);

  await setPanelOpen(page, FIRST_PANEL, true);
  const reopened = await captureLayout(page);
  expect(reopened.payload.panels[0].rect.height).toBe(openHeight);
});

test('a panel torn off after a restore opens above the restored panels', async ({
  page,
}) => {
  await openPreparedDataset(page);
  await undockFromHeader(page, FIRST_PANEL);
  await undockFromHeader(page, SECOND_PANEL);

  const captured = await captureLayout(page);
  /* A session saved after a while of work carries whatever layers the panels
     reached; raise them so the restore writes past anything a fresh page
     would hand out on its own. */
  const raised = {
    panels: captured.payload.panels.map((panel, index) => ({
      ...panel,
      z: 400 + index,
    })),
  };
  await restoreLayout(page, raised);
  expect(await panelLayer(page, FIRST_PANEL)).toBeGreaterThanOrEqual(400);

  await undockFromHeader(page, THIRD_PANEL);
  const thirdLayer = await panelLayer(page, THIRD_PANEL);
  const restoredLayers = await Promise.all([
    panelLayer(page, FIRST_PANEL),
    panelLayer(page, SECOND_PANEL),
  ]);
  expect(thirdLayer).toBeGreaterThan(Math.max(...restoredLayers));
});

test('a restored panel docks back into its own place in the sidebar', async ({
  page,
}) => {
  await openPreparedDataset(page);
  const dockedOrder = await sidebarPanelOrder(page);

  await undockFromHeader(page, SECOND_PANEL);
  const captured = await captureLayout(page);

  /* Restoring re-floats a panel that is standing in the sidebar. */
  await restoreLayout(page, captured.payload);
  await expect(page.locator(`#${SECOND_PANEL}`)).toHaveClass(
    /accordion-floating/
  );

  await page.locator(`#${SECOND_PANEL} > summary .accordion-dock-btn`).click();
  await expect(page.locator(`#${SECOND_PANEL}`)).not.toHaveClass(
    /accordion-floating/
  );

  expect(await sidebarPanelOrder(page)).toEqual(dockedOrder);
});
