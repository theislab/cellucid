/**
 * The sidebar control standard ("Sidebar Control Standard" in
 * assets/css/README.md) as the browser renders it:
 *
 * - equivalent controls compute the same type, size and shape wherever they
 *   are drawn, static or built by JavaScript;
 * - every visible control in the sidebar is named;
 * - disclosures and switches work from the keyboard and publish their state;
 * - a slider's work runs once per frame, and a legend refresh that changes
 *   one category rewrites only that category's row.
 *
 * No pixel snapshots: each check reads computed styles, ARIA and DOM writes.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=sidebar-control-standard-ci';

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('#sidebar details')) {
      details.open = true;
    }
  });
}

/** Computed style signatures of every visible element matching a selector. */
function styleSignatures(page, selector, properties) {
  return page.evaluate(({ selector, properties }) => {
    const out = [];
    for (const element of document.querySelectorAll(selector)) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      out.push({
        id: element.id || `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`,
        signature: properties.map(property => style.getPropertyValue(property)).join(' | '),
      });
    }
    return out;
  }, { selector, properties });
}

test('equivalent controls compute one look wherever they are built', async ({
  page,
}) => {
  await openDataset(page);
  // The analysis panel builds its controls in JavaScript; open one mode so
  // its labels, selects and buttons are compared with the static markup.
  await page.locator('#analysis-header-differential').click();
  await expect(page.locator('#analysis-header-differential'))
    .toHaveAttribute('aria-expanded', 'true');

  const groups = [
    {
      name: 'field labels',
      selector: '#sidebar label:not(.checkbox-inline), #sidebar .field-label',
      properties: ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform', 'color'],
      minimum: 20,
    },
    {
      name: 'option labels',
      selector: '#sidebar .checkbox-inline',
      properties: ['font-family', 'font-size', 'text-transform', 'color'],
      minimum: 8,
    },
    {
      name: 'sub-section headings',
      selector: '#sidebar .section-title',
      properties: ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform', 'color'],
      minimum: 10,
    },
    {
      name: 'secondary buttons',
      selector: '#sidebar .btn:not(.btn-compact):not(.btn-primary):not([aria-pressed="true"]):not(:disabled)',
      properties: ['font-family', 'font-size', 'letter-spacing', 'text-transform', 'border-radius', 'padding-top', 'padding-left', 'background-color'],
      minimum: 8,
    },
    {
      name: 'compact buttons',
      selector: '#sidebar .btn.btn-compact:not(.btn-primary):not([aria-pressed="true"]):not(:disabled)',
      properties: ['font-family', 'font-size', 'letter-spacing', 'border-radius', 'padding-top', 'padding-left'],
      minimum: 6,
    },
    {
      name: 'field boxes',
      selector: '#sidebar .obs-select:not(textarea)',
      properties: ['font-family', 'font-size', 'padding-top', 'padding-left', 'border-top-width', 'border-top-style', 'border-radius'],
      minimum: 10,
    },
    {
      name: 'icon buttons',
      selector: '#sidebar .icon-btn',
      properties: ['width', 'height', 'border-top-width', 'border-radius'],
      minimum: 10,
    },
    {
      name: 'slider readouts',
      selector: '#sidebar .slider-value',
      properties: ['font-family', 'font-size', 'text-align', 'color'],
      minimum: 5,
    },
    {
      name: 'settings boxes',
      selector: '#sidebar .control-box',
      properties: ['border-top-style', 'border-top-width', 'padding-top', 'padding-left', 'background-color'],
      minimum: 2,
    },
  ];
  for (const group of groups) {
    const signatures = await styleSignatures(page, group.selector, group.properties);
    expect(signatures.length, `${group.name} drawn`).toBeGreaterThanOrEqual(group.minimum);
    const distinct = new Map();
    for (const { id, signature } of signatures) {
      if (!distinct.has(signature)) distinct.set(signature, []);
      distinct.get(signature).push(id);
    }
    expect(
      [...distinct.entries()].map(([signature, ids]) => `${signature} ← ${ids.slice(0, 4).join(', ')}`),
      `${group.name} share one computed look`,
    ).toHaveLength(1);
  }
});

test('every visible sidebar control has an accessible name', async ({ page }) => {
  await openDataset(page);
  const anonymous = await page.evaluate(() => {
    const visible = element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const named = element => (
      (element.labels !== undefined && element.labels !== null && element.labels.length > 0)
      || (element.getAttribute('aria-label') || '').trim().length > 0
      || (element.getAttribute('aria-labelledby') || '').trim().length > 0
      || (element.localName === 'button' && element.textContent.trim().length > 0)
    );
    return [...document.querySelectorAll(
      '#sidebar input:not([type="hidden"]), #sidebar select, #sidebar textarea, #sidebar button',
    )]
      .filter(element => visible(element) && !named(element))
      .map(element => element.id || element.outerHTML.slice(0, 80));
  });
  expect(anonymous).toEqual([]);
});

test('disclosures and switches work from the keyboard and publish their state', async ({
  page,
}) => {
  await openDataset(page);
  const header = page.locator('#cat-builder-accordion-item .disclosure-header');
  const region = page.locator(`#${await header.getAttribute('aria-controls')}`);
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(region).toBeHidden();
  await header.focus();
  await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(region).toBeVisible();
  await page.keyboard.press('Space');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(region).toBeHidden();

  // A continuous field's legend draws its settings as switches.
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  const logSwitch = page.getByRole('switch', { name: 'Log color scale' });
  await expect(logSwitch).toHaveAttribute('aria-checked', 'false');
  await logSwitch.focus();
  await page.keyboard.press('Space');
  await expect(logSwitch).toHaveAttribute('aria-checked', 'true');
  // The range sliders are labelled fields with live readouts.
  await expect(page.getByRole('slider', { name: 'Minimum' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Maximum' })).toBeVisible();
});

test('a slider applies its work once per frame, with the latest value', async ({
  page,
}) => {
  await openDataset(page);
  const readouts = await page.evaluate(async () => {
    const slider = document.getElementById('outlier-filter');
    const readout = document.getElementById('outlier-filter-display');
    const before = readout.textContent;
    for (const value of [90, 80, 70, 60]) {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const sameTask = readout.textContent;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterFrame = readout.textContent;
    slider.value = '100';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, sameTask, afterFrame, committed: readout.textContent };
  });
  expect(readouts.sameTask).toBe(readouts.before);
  expect(readouts.afterFrame).toBe('60%');
  expect(readouts.committed).toBe('100%');
});

test('hiding one category rewrites only that category in the legend', async ({
  page,
}) => {
  await openDataset(page);
  const touched = await page.evaluate(async () => {
    const legend = document.getElementById('legend');
    const rows = [...legend.querySelectorAll('.legend-item')];
    const target = rows.find(row => row.querySelector('.legend-label-main').textContent === 'alpha');
    const records = [];
    const observer = new MutationObserver(list => records.push(...list));
    observer.observe(legend, { subtree: true, childList: true, characterData: true, attributes: true });
    target.querySelector('.legend-checkbox').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect();
    const owners = new Set();
    for (const record of records) {
      const node = record.target.nodeType === Node.ELEMENT_NODE
        ? record.target
        : record.target.parentElement;
      const row = node.closest('.legend-item');
      owners.add(row === null ? 'outside rows' : row.querySelector('.legend-label-main').textContent);
    }
    return { owners: [...owners].sort(), rows: legend.querySelectorAll('.legend-item').length };
  });
  expect(touched.rows).toBe(3);
  expect(touched.owners).toEqual(['alpha']);
});
