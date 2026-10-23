/**
 * The type scale and the touch geometry, as the browser computes them.
 *
 * Type ("Type scale" in assets/css/README.md): every element of one role
 * computes one size, and the scale stays flat on a desktop and on a phone —
 * a panel title one step above the one size headings, labels, controls and
 * buttons share, hints and readouts one step below it.
 *
 * Touch ("Rhythm and touch"): on a phone every boxed control and option row
 * is drawn compact, 32–38px tall, and its hit area reaches at least 42px by
 * extending past the drawn box. No neighbour's extension may take a point
 * inside a control's own drawn box. The legend rows' icon buttons opt out of
 * the extension: rows are packed one per line and the row itself is the
 * target there.
 *
 * No pixel snapshots: every check reads computed styles and hit testing.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=ui-type-and-touch-ci';

const ROLES = Object.freeze({
  title: '#sidebar .accordion-section > summary',
  heading: '#sidebar .section-title',
  label: '#sidebar label:not(.checkbox-inline), #sidebar .field-label',
  control: '#sidebar select.obs-select, #sidebar input.obs-select',
  button: '#sidebar .btn:not(.btn-compact)',
  compactButton: '#sidebar .btn-compact',
  hint: '#sidebar .field-help, #sidebar .status-line',
  readout: '#sidebar .slider-value',
});

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await page.evaluate(async () => {
    for (const details of document.querySelectorAll('#sidebar details')) details.open = true;
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    getNotificationCenter().dismissAll();
  });
}

/** Distinct computed font sizes (px) of every visible element of each role. */
function roleSizes(page) {
  return page.evaluate(roles => {
    const out = {};
    for (const [role, selector] of Object.entries(roles)) {
      const sizes = new Set();
      for (const element of document.querySelectorAll(selector)) {
        if (element.getClientRects().length === 0) continue;
        if (!(element.textContent || element.value || '').trim()) continue;
        sizes.add(Number.parseFloat(getComputedStyle(element).fontSize));
      }
      out[role] = [...sizes].sort((a, b) => a - b);
    }
    return out;
  }, ROLES);
}

function expectTypeOrder(sizes) {
  for (const [role, values] of Object.entries(sizes)) {
    expect(values.length, `${role} is drawn`).toBeGreaterThan(0);
    expect(values, `every ${role} computes one size`).toHaveLength(1);
  }
  const size = role => sizes[role][0];
  const base = size('heading');
  for (const role of ['label', 'control', 'button', 'compactButton']) {
    expect(size(role), `${role} is the base size`).toBe(base);
  }
  expect(size('title') - base, 'a panel title is one step above the base').toBe(1);
  expect(base - size('hint'), 'a hint is one step below the base').toBe(1);
  expect(base - size('readout'), 'a readout is one step below the base').toBe(1);
}

test.describe('desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the sidebar type roles keep one size each and their order', async ({ page }) => {
    await openDataset(page);
    expectTypeOrder(await roleSizes(page));
  });
});

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the sidebar type roles keep one size each and their order on touch', async ({
    page,
  }) => {
    await openDataset(page);
    const phone = await roleSizes(page);
    expectTypeOrder(phone);
    // The scale steps up on a coarse pointer and never shrinks.
    expect(phone.control[0]).toBe(13);
  });

  test('controls are drawn compact with a fingertip hit area of their own', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openDataset(page);
    const report = await page.evaluate(async () => {
      const CONTROLS = [
        '.btn', '.icon-btn:not(.legend-item .icon-btn)', '.segmented-btn',
        'select.obs-select', 'input.obs-select', '.switch', '.checkbox-inline',
      ].map(selector => `#sidebar ${selector}`).join(', ');
      const INTERACTIVE = 'button, select, input, textarea, summary, a[href], label, [tabindex="0"]';
      const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
      const name = element => element.id
        || `${element.localName}.${[...element.classList].slice(0, 2).join('.')} "${(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 20)}"`;
      const owns = (element, x, y) => {
        const hit = document.elementFromPoint(x, y);
        if (!hit) return false;
        if (hit === element || element.contains(hit)) return true;
        const owner = hit.closest(INTERACTIVE);
        return owner === element
          || (owner?.localName === 'label' && (owner.control === element || owner.contains(element)))
          || (element.localName === 'label' && element.control === hit);
      };
      const drawn = [];
      const hits = [];
      const stolen = [];
      let checked = 0;
      for (const element of document.querySelectorAll(CONTROLS)) {
        if (element.getClientRects().length === 0) continue;
        const first = element.getBoundingClientRect();
        if (first.width < 2 || first.height < 2) continue;
        if (element.closest('.select-bar')) continue;
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await frame();
        const outer = element.getBoundingClientRect();
        // A one-line field takes its hit area as transparent border, so its
        // drawn box is the border box less any transparent border.
        const style = getComputedStyle(element);
        const clear = side => style[`border${side}Color`] === 'rgba(0, 0, 0, 0)'
          ? Number.parseFloat(style[`border${side}Width`])
          : 0;
        const box = {
          left: outer.left,
          right: outer.right,
          width: outer.width,
          top: outer.top + clear('Top'),
          bottom: outer.bottom - clear('Bottom'),
        };
        box.height = box.bottom - box.top;
        checked += 1;
        if (box.height < 32 - 0.5 || box.height > 38 + 0.5) {
          drawn.push(`${name(element)}: drawn ${box.height.toFixed(1)}px tall`);
        }
        const x = box.left + Math.min(box.width / 2, 12);
        let top = box.top;
        let bottom = box.bottom;
        for (let y = box.top - 0.5; y > box.top - 8; y -= 1) {
          if (!owns(element, x, y)) break;
          top = y;
        }
        for (let y = box.bottom + 0.5; y < box.bottom + 8; y += 1) {
          if (!owns(element, x, y)) break;
          bottom = y;
        }
        if (bottom - top < 42 - 1) {
          drawn.push(`${name(element)}: hit area ${(bottom - top).toFixed(1)}px`);
        }
        hits.push(Math.round(bottom - top));
        for (const [px, py] of [
          [box.left + 1, box.top + 1], [box.right - 1, box.top + 1],
          [box.left + 1, box.bottom - 1], [box.right - 1, box.bottom - 1],
          [box.left + box.width / 2, box.top + box.height / 2],
        ]) {
          if (!owns(element, px, py)) {
            const hit = document.elementFromPoint(px, py);
            stolen.push(`${name(element)}: (${Math.round(px - box.left)}, ${Math.round(py - box.top)}) goes to ${hit ? name(hit.closest(INTERACTIVE) ?? hit) : 'nothing'}`);
            break;
          }
        }
      }
      return { checked, drawn, stolen, minimumHit: Math.min(...hits) };
    });
    expect(report.checked, 'controls walked').toBeGreaterThan(60);
    expect.soft(report.drawn, 'drawn 32–38px with a 42px hit area').toEqual([]);
    expect(report.stolen, 'points inside a control belong to it').toEqual([]);
  });
});
