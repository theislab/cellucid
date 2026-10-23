/**
 * Visual-consistency defects found by screenshotting every panel at desktop,
 * tablet, phone and phone-landscape sizes in both themes. Each test pins the
 * geometry or colour that was wrong, never a pixel snapshot.
 *
 * - Touch layouts drew controls for a cursor: 24-29px text buttons and
 *   fields, 13px checkboxes behind 19px labels, and 11px field text that makes
 *   iOS Safari zoom the page on focus.
 * - On a touch tablet the 260px sidebar squeezed the field select beside its
 *   four action buttons down to a few letters.
 * - Native checkboxes kept the browser's blue in some panels and the theme's
 *   ink in others.
 * - An analysis row that followed the page selector touched it.
 * - A selected "Rest of" page chip turned white-on-pale-blue under the
 *   pointer, and the chip cut every page name at 110px.
 * - The Marker Genes method select had no visible label.
 * - In-panel disclosures drew a ▲/▼ text glyph; a nested chevron inherited
 *   its parent item's open state.
 * - Keyboard shortcut descriptions started wherever each key combination
 *   happened to end.
 * - The community-annotation wizard's step text scrolled through a strip
 *   under its sticky Back/Next bar on a short screen.
 * - The multiview layout select had no accessible name.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=design-polish-ci';

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
}

async function openSection(page, id) {
  await page.locator(`#${id}`).evaluate(details => {
    details.open = true;
  });
}

async function openAnalysisMode(page, mode) {
  await openSection(page, 'page-analysis-section');
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator(
    `.analysis-mode-content[data-mode="${mode}"]`,
  );
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('aria-busy', 'true');
  return panel;
}

test.describe('touch layouts', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a phone draws compact controls and never scrolls sideways', async ({
    page,
  }) => {
    await openDataset(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))
      .toBe(true);
    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
    await expect(page.locator('.legend-item')).toHaveCount(3);
    await page.evaluate(() => {
      for (const details of document.querySelectorAll('#sidebar details')) {
        details.open = true;
      }
    });

    const report = await page.evaluate(() => {
      const visible = element => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const describe = element => element.id
        ? `#${element.id}`
        : `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`;
      const small = [];
      const controls = document.querySelectorAll([
        '#sidebar button',
        '#sidebar select',
        '#sidebar input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"])',
        '#sidebar label:has(> input[type="checkbox"])',
      ].join(','));
      for (const element of controls) {
        if (!visible(element)) continue;
        // The "i" buttons keep a 14px circle and widen an invisible ring
        // instead, so a larger box cannot reach the control under them.
        if (element.matches('.info-btn')) continue;
        // A control is drawn at least 32px tall on touch (36px for a field,
        // a button and an option row); its hit area reaches past that, which
        // ui-type-and-touch.spec.mjs measures.
        const box = element.getBoundingClientRect();
        if (box.height < 31.5) {
          small.push(`${describe(element)} ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      }
      return {
        controls: controls.length,
        small,
        overflow: document.documentElement.scrollWidth - innerWidth,
        sidebarOverflow: (() => {
          const scroller = document.querySelector('#sidebar .sidebar-scroll');
          return scroller.scrollWidth - scroller.clientWidth;
        })(),
      };
    });
    expect(report.controls).toBeGreaterThan(60);
    expect(report.small, 'controls drawn under 32px on a touch screen').toEqual([]);
    expect(report.overflow).toBeLessThanOrEqual(0);
    expect(report.sidebarOverflow).toBeLessThanOrEqual(0);

    // The icon-only field and legend actions are drawn 36px square.
    for (const selector of [
      '#copy-categorical-field',
      '#clear-categorical-field',
      '.legend-rename-btn',
      '.legend-delete-btn',
    ]) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box.width, selector).toBeGreaterThanOrEqual(36);
      expect(box.height, selector).toBeGreaterThanOrEqual(36);
    }

    // The close control's strip grows with it, so it still covers no content.
    const toggle = await page.locator('#sidebar-toggle').boundingBox();
    expect(toggle.height).toBeGreaterThanOrEqual(44);
    const sidebarPadding = await page.locator('#sidebar').evaluate(
      element => parseFloat(getComputedStyle(element).paddingTop),
    );
    expect(sidebarPadding).toBeGreaterThanOrEqual(toggle.y + toggle.height);
  });
});

test.describe('touch tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test('a field select keeps a readable width beside its touch-sized actions', async ({
    page,
  }) => {
    await openDataset(page);
    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
    for (const id of ['categorical-field', 'continuous-field']) {
      const geometry = await page.locator(`#${id}`).evaluate(select => {
        const actions = select.parentElement.querySelector('.field-actions');
        const box = select.getBoundingClientRect();
        const actionBox = actions.getBoundingClientRect();
        return {
          width: box.width,
          rowWidth: select.parentElement.getBoundingClientRect().width,
          actionsBelow: actionBox.top >= box.bottom - 0.5,
        };
      });
      // Either the select has room beside the actions or it takes the whole
      // row and the actions move under it; it is never squeezed.
      expect(geometry.width, id).toBeGreaterThanOrEqual(140);
      if (geometry.actionsBelow) {
        expect(geometry.width).toBeGreaterThanOrEqual(geometry.rowWidth - 1);
      }
    }
  });
});

test('every native checkbox takes the theme ink in light and dark', async ({
  page,
}) => {
  await openDataset(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  for (const theme of ['light', 'dark']) {
    await page.locator('#theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const readAccents = () => page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-interactive-primary)';
      document.body.appendChild(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      // A checkbox the user can see. Linux WebKit does not restyle elements
      // inside hidden subtrees (closed sections and menus) when the theme's
      // custom properties change; it restyles them when they are shown, so
      // only rendered boxes are what a user can see in the wrong ink.
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
        .filter(box => box.getClientRects().length > 0);
      return {
        ink,
        count: boxes.length,
        other: boxes
          .filter(box => getComputedStyle(box).accentColor !== ink)
          .map(box => `${box.id || box.name || 'unnamed'}=${getComputedStyle(box).accentColor}`),
      };
    });
    // Restyling can also land a moment after the switch, so the boxes are
    // sampled until they settle rather than once.
    let accents = await readAccents();
    await expect.poll(async () => {
      accents = await readAccents();
      return accents.other;
    }, { message: `${theme}: checkboxes not in the theme ink` }).toEqual([]);
    expect(accents.count).toBeGreaterThan(5);
  }
});

test('analysis rows keep one rhythm and the page chips stay legible', async ({
  page,
}) => {
  await openDataset(page);
  const panel = await openAnalysisMode(page, 'correlation');

  // The row after the page selector's Deselect All stands clear of it, the
  // same distance any two rows are apart.
  const gaps = await panel.evaluate(element => {
    const actions = element.querySelector('.analysis-page-actions');
    const next = element.querySelector(
      '.analysis-page-selector + .control-block',
    );
    const rows = [...element.querySelectorAll('.analysis-page-selector ~ .control-block')];
    return {
      afterSelector: next.getBoundingClientRect().top
        - actions.getBoundingClientRect().bottom,
      betweenRows: rows[1].getBoundingClientRect().top
        - rows[0].getBoundingClientRect().bottom,
    };
  });
  expect(gaps.afterSelector).toBeGreaterThanOrEqual(4);
  expect(Math.abs(gaps.afterSelector - gaps.betweenRows)).toBeLessThanOrEqual(1);

  // A selected derived chip keeps its selected colours under the pointer and
  // shows its whole name.
  const chip = panel.locator('.chip.chip-derived[aria-pressed="true"]').first();
  await expect(chip).toBeVisible();
  await chip.hover();
  const chipState = await chip.evaluate(element => {
    const name = element.querySelector('.chip-name');
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-interactive-primary)';
    document.body.appendChild(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return {
      background: getComputedStyle(element).backgroundColor,
      ink,
      nameFits: name.scrollWidth <= name.clientWidth + 1,
    };
  });
  expect(chipState.background).toBe(chipState.ink);
  expect(chipState.nameFits).toBe(true);
});

test('marker genes names its method and its disclosures draw one chevron', async ({
  page,
}) => {
  await openDataset(page);
  const panel = await openAnalysisMode(page, 'genesPanel');
  await expect(panel.getByLabel('Statistical method', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Mode', { exact: true })).toBeVisible();

  const headers = panel.locator('.disclosure-inline .disclosure-header');
  await expect(headers).toHaveCount(2);
  for (const header of await headers.all()) {
    const chevron = header.locator('> .disclosure-chevron');
    await expect(chevron).toHaveText('');
    // Closed inside an open item, so it must not inherit the item's turn.
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(chevron).toHaveCSS('transform', 'none');
  }
});

test('shortcut descriptions share one left edge and keys sit flush right', async ({
  page,
}) => {
  await openDataset(page);
  await openSection(page, 'shortcuts-section');
  const edges = await page.locator('#shortcuts-section').evaluate(section => {
    const items = [...section.querySelectorAll('.shortcut-item')];
    return items.map(item => ({
      descLeft: item.querySelector('.shortcut-desc').getBoundingClientRect().left,
      keysRight: item.querySelector('.shortcut-keys').getBoundingClientRect().right,
    }));
  });
  expect(edges.length).toBeGreaterThan(15);
  const lefts = new Set(edges.map(edge => Math.round(edge.descLeft)));
  const rights = new Set(edges.map(edge => Math.round(edge.keysRight)));
  expect([...lefts]).toHaveLength(1);
  expect([...rights]).toHaveLength(1);
  // Every group stands the same distance from the one above it.
  const groupGaps = await page.locator('#shortcuts-section').evaluate(section => {
    const lists = [...section.querySelectorAll('.shortcuts-list')];
    return lists.slice(1).map((list, index) =>
      Math.round(list.getBoundingClientRect().top
        - lists[index].getBoundingClientRect().bottom));
  });
  expect(new Set(groupGaps).size).toBe(1);
});

test('the multiview layout select is named and takes the free width', async ({
  page,
}) => {
  await openDataset(page);
  await openSection(page, 'compare-views-section');
  // The layout row belongs to the kept-view list, shown once a view is kept.
  await page.locator('#split-keep-view-btn').click();
  const select = page.getByLabel('Layout', { exact: true });
  await expect(select).toBeVisible();
  await expect(select).toHaveAttribute('id', 'view-layout-mode');
  const widths = await select.evaluate(element => ({
    select: element.getBoundingClientRect().width,
    row: element.closest('.split-view-actions').getBoundingClientRect().width,
  }));
  expect(widths.select).toBeGreaterThan(widths.row * 0.4);
});

test.describe('short screen', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test('startup notifications never cover the welcome dialog', async ({ page }) => {
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    const modal = page.locator('#welcome-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI fixture',
    );
    await expect(page.locator('.notification').first()).toBeVisible();
    const covering = await page.evaluate(() => {
      const dialog = document.querySelector('#welcome-modal .welcome-content');
      // Touch layouts let taps through notifications; hit-test what is drawn.
      const probe = document.createElement('style');
      probe.textContent = '.notification { pointer-events: auto !important; }';
      document.head.appendChild(probe);
      return [...document.querySelectorAll('.notification')].filter(note => {
        const box = note.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return hit !== null && note.contains(hit) && !dialog.contains(hit);
      }).length + (probe.remove(), 0);
    });
    expect(covering).toBe(0);
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    // With the dialog gone the notification layer shows again. The startup
    // notices auto-dismiss after a few seconds, which a slow renderer can
    // spend before this point, so a persistent one is published here.
    await page.evaluate(async () => {
      const { getNotificationCenter } = await import(
        '/assets/js/app/notification-center.js'
      );
      getNotificationCenter().info('A notice after the welcome dialog', { duration: 0 });
    });
    await expect(
      page.locator('.notification', { hasText: 'A notice after the welcome dialog' }),
    ).toBeVisible();
  });

  test('the GitHub sync wizard text never scrolls out under its Back/Next bar', async ({
    page,
  }) => {
    await openDataset(page);
    await openSection(page, 'community-annotation-section');
    await page.locator('#community-annotation-section')
      .getByRole('button', { name: 'Connect repo', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'GitHub sync', exact: true });
    await expect(dialog).toBeVisible();
    const geometry = await dialog.evaluate(modal => {
      const body = modal.querySelector('.community-annotation-modal-body');
      const nav = modal.querySelector('.community-annotation-wizard-nav');
      const back = modal.querySelector('.community-annotation-wizard-prev');
      return {
        scrolls: body.scrollHeight > body.clientHeight,
        bodyBottom: body.getBoundingClientRect().bottom,
        navBottom: nav.getBoundingClientRect().bottom,
        backBottom: back.getBoundingClientRect().bottom,
      };
    });
    // The body is taller than the screen, so the bar is pinned over it; it
    // must reach the body's bottom edge or text shows through underneath.
    expect(geometry.scrolls).toBe(true);
    expect(Math.abs(geometry.navBottom - geometry.bodyBottom)).toBeLessThanOrEqual(1);
    expect(geometry.navBottom - geometry.backBottom).toBeGreaterThanOrEqual(4);
  });
});
