/**
 * Visual consistency defects found by driving the running app in both themes.
 *
 * - In dark theme the welcome dialog's logo, dark ink by design, sat on the
 *   dark dialog surface and all but vanished; the sidebar's copy of the same
 *   logo was already on a light card.
 * - Selects drew their chevron over their own text ("Current UI
 *   fixture (120 cells)" ran underneath it), and text inputs that borrow the
 *   select box style drew a chevron for a list that does not exist.
 * - The filter count was the one line of the interface set in Georgia.
 * - An open section's chevron pointed left, while every nested disclosure
 *   points up when open.
 * - A finished load stayed announced as "Downloading".
 * - An opened analysis row still cut its description off with an ellipsis,
 *   the only way to read it being a hover that touch screens do not have.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { settleStyleTransitions } from './helpers/style-transitions.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=ui-visual-consistency-ci';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function useTheme(page, theme) {
  await page.addInitScript(value => {
    localStorage.setItem('cellucid_theme', value);
  }, theme);
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
}

function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
    .map(value => {
      const scaled = value / 255;
      return scaled <= 0.03928
        ? scaled / 12.92
        : ((scaled + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('in dark theme both logo surfaces follow the theme and the wordmark is inverted', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await useTheme(page, 'dark');
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const welcome = page.locator('#welcome-modal');
  await expect(welcome).toBeVisible();

  const surfaces = await page.evaluate(() => ({
    welcome: getComputedStyle(document.querySelector('.welcome-header'))
      .backgroundColor,
    sidebar: getComputedStyle(document.querySelector('.sidebar-brand'))
      .backgroundColor,
    dialog: getComputedStyle(document.querySelector('.welcome-content'))
      .backgroundColor,
    filters: [...document.querySelectorAll('.sidebar-logo, .welcome-logo')]
      .map(logo => getComputedStyle(logo).filter),
  }));
  expect(luminance(surfaces.welcome)).toBeLessThan(0.1);
  expect(luminance(surfaces.sidebar)).toBeLessThan(0.1);
  expect(luminance(surfaces.dialog)).toBeLessThan(0.1);
  expect(surfaces.filters).toEqual([
    'invert(1) hue-rotate(180deg)',
    'invert(1) hue-rotate(180deg)',
  ]);

  await page.keyboard.press('Escape');
  await expect(welcome).toBeHidden();
  expect(productErrors).toEqual([]);
});

test('select text stops short of the chevron, and only selects draw one', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  const selects = await page.evaluate(() =>
    [...document.querySelectorAll('select.obs-select, #background-select')]
      .filter(select => select.getClientRects().length > 0)
      .map(select => {
        const style = getComputedStyle(select);
        return {
          id: select.id,
          paddingRight: Number.parseFloat(style.paddingRight),
          chevron: style.backgroundImage.includes('gradient'),
        };
      }));
  expect(selects.length).toBeGreaterThan(5);
  for (const select of selects) {
    expect(select.chevron, `${select.id} draws the chevron`).toBe(true);
    expect(
      select.paddingRight,
      `${select.id} keeps its text clear of the chevron`,
    ).toBeGreaterThanOrEqual(20);
  }

  // A text or number field dressed as a select carries no chevron.
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll('input.obs-select')].map(input => ({
      id: input.id || input.className,
      backgroundImage: getComputedStyle(input).backgroundImage,
    })));
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    expect(field.backgroundImage, field.id).toBe('none');
  }
  expect(productErrors).toEqual([]);
});

test('every line of interface copy uses one of the three token typefaces', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  const families = await page.evaluate(() => {
    // Resolve each token the way an element would, so engine normalisation of
    // the family list applies to both sides of the comparison.
    const tokens = ['--font-sans', '--font-display', '--font-mono'].map(name => {
      const probe = document.createElement('span');
      probe.style.fontFamily = `var(${name})`;
      document.body.appendChild(probe);
      const family = getComputedStyle(probe).fontFamily;
      probe.remove();
      return family;
    });
    const offenders = [];
    for (const element of document.querySelectorAll('#sidebar *')) {
      const ownText = [...element.childNodes].some(
        node => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
      );
      if (!ownText || element.getClientRects().length === 0) continue;
      const family = getComputedStyle(element).fontFamily;
      if (!tokens.includes(family)) {
        offenders.push(`${element.id || element.className}: ${family}`);
      }
    }
    return { offenders, filterCount: getComputedStyle(
      document.getElementById('filter-count'),
    ).fontFamily, sans: tokens[0] };
  });
  expect(families.offenders).toEqual([]);
  expect(families.filterCount).toBe(families.sans);
  expect(productErrors).toEqual([]);
});

test('an open section points its chevron up, the way nested disclosures do', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  const angle = selector => page.evaluate(target => {
    const transform = getComputedStyle(
      document.querySelector(target),
      '::before',
    ).transform;
    const [a, b] = transform.match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number);
    return Math.round((Math.atan2(b, a) * 180) / Math.PI);
  }, selector);

  const section = page.locator('#figure-export-section');
  await expect(section).not.toHaveAttribute('open', '');
  // Closed: the border chevron is rotated 45deg and reads as "v".
  expect(await angle('#figure-export-section > summary')).toBe(45);
  await section.locator('> summary').click();
  await expect(section).toHaveAttribute('open', '');
  // Open: rotated a further half turn so it reads as "^", never "<".
  await expect.poll(() => angle('#figure-export-section > summary'))
    .toBe(-135);
  expect(productErrors).toEqual([]);
});

test('a finished load is announced as loaded', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  const positions = page.locator('.notification', {
    hasText: '2D cell positions',
  });
  await expect(positions).toHaveAttribute('data-type', 'success');
  await expect(positions.locator('.notification-title')).toHaveText(
    'Loaded',
  );
  expect(productErrors).toEqual([]);
});

test('an analysis row is its title alone; its explanation is in its (i)', async ({ page }) => {
  // A description squeezed beside the title read as a few letters and an
  // ellipsis. The row now shows the title only, and the (i) beside it opens
  // the full explanation with links to the docs.
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  const header = page.locator('#analysis-header-differential');
  await expect(header.locator('.disclosure-desc')).toHaveCount(0);
  await expect(header.locator('.disclosure-title')).toHaveText('Differential expression');

  const info = header.locator('xpath=..').locator('.info-btn');
  await expect(info).toHaveCount(1);
  await info.click();
  const tip = page.locator(`[id="${await info.getAttribute('aria-controls')}"]`);
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Learn more');
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();

  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(productErrors).toEqual([]);
});

test('a mouse layout keeps its dense icon controls', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches))
    .toBe(true);
  const box = await page.locator('#copy-categorical-field').boundingBox();
  expect(box.width).toBeLessThan(20);
  expect(productErrors).toEqual([]);
});

test('every dialog card is the same square card', async ({ page }) => {
  // The license and expanded-analysis dialogs were rounded glass panels with
  // gradients, beside square welcome, confirm, figure-export and community
  // dialogs. Every dialog is one square card with the quiet surface edge.
  const productErrors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  const welcome = page.locator('#welcome-modal');
  await expect(welcome).toBeVisible();
  const frame = selector => page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return {
      radius: style.borderTopLeftRadius,
      border: `${style.borderTopWidth} ${style.borderTopStyle}`,
      backgroundImage: style.backgroundImage,
    };
  });
  const reference = await frame('.welcome-content');
  expect(reference).toEqual({
    radius: '0px',
    border: '1px solid',
    backgroundImage: 'none',
  });
  await page.keyboard.press('Escape');
  await expect(welcome).toBeHidden();

  await page.locator('#license-link').click();
  await expect(page.locator('#license-modal')).toBeVisible();
  expect(await frame('.license-content')).toEqual(reference);
  await page.keyboard.press('Escape');
  await expect(page.locator('#license-modal')).toBeHidden();

  // The expanded analysis view is created on demand; its card class is styled
  // whether or not one is open, so a detached probe reads the same cascade.
  const analysisCard = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'analysis-modal-content';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const result = {
      radius: style.borderTopLeftRadius,
      border: `${style.borderTopWidth} ${style.borderTopStyle}`,
      backgroundImage: style.backgroundImage,
    };
    probe.remove();
    return result;
  });
  expect(analysisCard).toEqual(reference);
  expect(productErrors).toEqual([]);
});

/**
 * Every line of sidebar copy, as rendered, against the surface it sits on.
 * The theme contract checks token pairs; this checks what the cascade makes of
 * them — opacity stacked on an inherited colour, or text on the sunken paper
 * behind the cards — which is where help text (3.6:1) and the footer (4.3:1)
 * fell below WCAG AA in light theme.
 */
function renderedContrastFailures(page) {
  return page.evaluate(() => {
    const parse = value => {
      if (!value || value === 'transparent') return null;
      const rgb = value.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const parts = rgb[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
      }
      const srgb = value.match(/color\(srgb ([^)]+)\)/);
      if (srgb) {
        const parts = srgb[1].split(/[ /]+/).filter(Boolean).map(Number);
        return {
          r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255,
          a: parts[3] ?? 1,
        };
      }
      return null;
    };
    const channel = value => {
      const scaled = value / 255;
      return scaled <= 0.03928
        ? scaled / 12.92
        : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ({ r, g, b }) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const background = element => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) {
          layers.push(color);
          if (color.a >= 1) break;
        }
      }
      let result = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result);
      return result;
    };
    const failures = [];
    for (const element of document.querySelectorAll('#sidebar *')) {
      const ownText = [...element.childNodes].some(
        node => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
      );
      if (!ownText || element.getClientRects().length === 0) continue;
      if (element.closest(':disabled, [aria-disabled="true"]')) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden') continue;
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      // A fully transparent glyph draws no ink to read — the kept-view
      // badge's camera mark is laid out but transparent until its view owns
      // the camera.
      if (opacity === 0) continue;
      const ink = parse(style.color);
      if (ink === null) continue;
      const surface = background(element);
      const text = over({ ...ink, a: ink.a * opacity }, surface);
      const [hi, lo] = [luminance(text), luminance(surface)]
        .sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        failures.push(
          `${ratio.toFixed(2)}:1 ${element.id || element.className}`
          + ` "${element.textContent.trim().slice(0, 40)}"`,
        );
      }
    }
    return failures;
  });
}

for (const theme of ['light', 'dark']) {
  test(`sidebar copy clears WCAG AA contrast as rendered in ${theme} theme`, async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await useTheme(page, theme);
    await openDataset(page);
    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
    await expect(page.locator('.legend-item')).toHaveCount(3);
    await page.evaluate(() => {
      for (const section of document.querySelectorAll(
        '#sidebar details.accordion-section',
      )) section.open = true;
    });
    // Let the theme and disclosure transitions settle before sampling colour.
    await settleStyleTransitions(page);
    expect(await renderedContrastFailures(page)).toEqual([]);
    expect(productErrors).toEqual([]);
  });
}

/**
 * The sweep above samples a closed legend. The colormap menu only exists for a
 * continuous field and only renders while open, so its selected row — the one
 * row drawn on the inverse highlight — was never measured: its label kept its
 * own primary-text colour, primary on primary, and could not be read in either
 * theme. A kept view is open too, so the active view badge is measured on the
 * same highlight.
 */
for (const theme of ['light', 'dark']) {
  test(`an open colormap menu, selected palette included, clears WCAG AA in ${theme} theme`, async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await useTheme(page, theme);
    await openDataset(page);
    await page.locator('#continuous-field').selectOption('score');
    await page.locator('#split-keep-view-btn').click();
    await expect(page.locator('#split-view-badges-list > *')).not.toHaveCount(0);

    const palette = page.locator('#legend .colorbar-gradient');
    await palette.click();
    await expect(palette).toHaveAttribute('aria-expanded', 'true');
    const selected = page.locator(
      '#legend .colormap-option[aria-pressed="true"]',
    );
    await expect(selected).toHaveCount(1);
    await expect(selected.locator('.colormap-name')).toBeVisible();
    // Let the theme and menu transitions settle before sampling colour.
    await settleStyleTransitions(page);
    expect(await renderedContrastFailures(page)).toEqual([]);
    expect(productErrors).toEqual([]);
  });
}

test.describe('a phone held sideways', () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test('keeps every dialog inside the screen, scrolling instead of clipping', async ({
    page,
  }) => {
    // The welcome card is 477px tall; on a 375px-tall screen it lost 51px past
    // the top edge and as much past the bottom, with nothing to scroll. The
    // expanded analysis view had a fixed 500px minimum height.
    const productErrors = observeProductErrors(page);
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    const welcome = page.locator('#welcome-modal');
    await expect(welcome).toBeVisible();
    const card = page.locator('.welcome-content');
    const box = await card.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(375);
    const scrolls = await card.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollHeight > element.clientHeight && element.scrollTop > 0;
    });
    expect(scrolls).toBe(true);
    await expect(page.locator('.welcome-quote')).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(welcome).toBeHidden();

    const analysisMinimum = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'analysis-modal-content';
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const size = {
        minWidth: Number.parseFloat(style.minWidth),
        minHeight: Number.parseFloat(style.minHeight),
      };
      probe.remove();
      return size;
    });
    expect(analysisMinimum.minWidth).toBeLessThanOrEqual(667);
    expect(analysisMinimum.minHeight).toBeLessThanOrEqual(375);
    expect(productErrors).toEqual([]);
  });
});

test.describe('a tablet-width multiview', () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test('keeps every view title clear of the sidebar and its toggle', async ({
    page,
  }) => {
    // Each title chip is centred on its cell. The cells are laid out right of
    // the sidebar, so no title — the control that focuses that view — is
    // hidden under the sidebar or its toggle tab, even at tablet width.
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await page.locator('#split-keep-view-btn').click();
    const chips = page.locator('.view-title-chip');
    await expect(chips).toHaveCount(2);

    const reachable = () => page.evaluate(() => {
      const toggle = document.getElementById('sidebar-toggle')
        .getBoundingClientRect();
      return [...document.querySelectorAll('.view-title-chip')].map(chip => {
        const box = chip.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return {
          topmost: hit === chip,
          clearOfToggle: box.left >= toggle.right,
        };
      });
    });
    await expect.poll(reachable).toEqual([
      { topmost: true, clearOfToggle: true },
      { topmost: true, clearOfToggle: true },
    ]);

    // With the sidebar hidden the cells take the whole width once its slide
    // has finished: the first title goes back to its cell centre and still
    // clears the toggle tab.
    await page.locator('#sidebar-toggle').click();
    await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
    await expect.poll(() => chips.first().evaluate(chip => {
      const box = chip.getBoundingClientRect();
      return Math.abs(box.left + box.width / 2 - 820 / 4) < 2;
    })).toBe(true);
    await expect.poll(reachable).toEqual([
      { topmost: true, clearOfToggle: true },
      { topmost: true, clearOfToggle: true },
    ]);
    expect(productErrors).toEqual([]);
  });
});

test.describe('a tablet-width four-view grid', () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test('keeps each view title inside its own pane, however long', async ({
    page,
  }) => {
    // Narrow panes used to let long titles run into the next pane's chip.
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    for (let count = 2; count <= 4; count++) {
      await page.locator('#split-keep-view-btn').click();
      await expect(page.locator('.view-title-chip')).toHaveCount(count);
    }
    const placement = () => page.evaluate(() => {
      const chips = [...document.querySelectorAll('.view-title-chip')];
      for (const chip of chips) {
        chip.textContent = 'a very long field name for a narrow pane, longer than any pane is wide';
      }
      const { panes } = window._cellucidViewer.getPresentedLayout();
      const boxes = chips.map(chip => chip.getBoundingClientRect());
      const insidePane = boxes.every((box, index) => (
        box.left >= panes[index].visibleCssLeft - 1
        && box.right <= panes[index].visibleCssLeft + panes[index].visibleCssWidth + 1
      ));
      const overlaps = boxes.some((a, i) => boxes.some((b, j) => (
        i < j && a.left < b.right && b.left < a.right
        && a.top < b.bottom && b.top < a.bottom
      )));
      const truncated = chips.every(chip => chip.scrollWidth > chip.clientWidth);
      return { insidePane, overlaps, truncated };
    });
    await expect.poll(placement).toEqual({
      insidePane: true,
      overlaps: false,
      truncated: true,
    });
    expect(productErrors).toEqual([]);
  });
});

test('an icon-only control shows on hover the words it announces', async ({
  page,
}) => {
  // The analysis rows' copy buttons were announced as "Copy Quick analysis
  // window" but showed only "Copy" on hover, which reads as copy-to-clipboard;
  // the add-page button showed "Add new page" for "Add highlight page".
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await page.evaluate(() => {
    for (const section of document.querySelectorAll(
      '#sidebar details.accordion-section',
    )) section.open = true;
  });
  const mismatches = await page.evaluate(() =>
    [...document.querySelectorAll('#sidebar button[title][aria-label]')]
      .filter(button => button.getClientRects().length > 0)
      .filter(button => button.title !== button.getAttribute('aria-label'))
      .map(button => `${button.id || button.className}: title "${button.title}"`
        + ` vs label "${button.getAttribute('aria-label')}"`));
  expect(mismatches).toEqual([]);
  expect(productErrors).toEqual([]);
});

test('Select mode and its combine choice never look like a highlight tool', async ({
  page,
}) => {
  await openDataset(page);
  await page.locator('#highlight-select-mode').click();
  // Let the switch's colour transition settle before sampling it.
  const trackColour = id => page.locator(`#${id} .switch-track`)
    .evaluate(element => getComputedStyle(element).backgroundColor);
  await expect.poll(() => trackColour('highlight-select-mode'))
    .toBe(await trackColour('select-bar-mode'));
  const looks = await page.evaluate(() => {
    const style = element => {
      const computed = getComputedStyle(element);
      return {
        radius: computed.borderTopLeftRadius,
        border: computed.borderTopWidth,
        transform: computed.textTransform,
        font: computed.fontFamily,
      };
    };
    const track = id => {
      const computed = getComputedStyle(
        document.querySelector(`#${id} .switch-track`),
      );
      return {
        width: computed.width,
        height: computed.height,
        background: computed.backgroundColor,
        radius: computed.borderTopLeftRadius,
      };
    };
    return {
      tool: style(document.getElementById('highlight-mode-lasso')),
      toggle: style(document.getElementById('highlight-select-mode')),
      barToggle: style(document.getElementById('select-bar-mode')),
      combine: style(document.getElementById('highlight-select-combine-union')),
      barCombine: style(document.getElementById('select-bar-combine-union')),
      track: track('highlight-select-mode'),
      barTrack: track('select-bar-mode'),
      roles: ['highlight-select-mode', 'select-bar-mode']
        .map(id => document.getElementById(id).getAttribute('role')),
      toggleInToolGroup: Boolean(
        document.getElementById('highlight-select-mode').closest('#highlight-mode')
      ),
    };
  });
  // The four tools are bordered pills; Select mode changes how every tool is
  // triggered, so it is a borderless switch and a square segmented control,
  // and the selection bar draws exactly the same two components. Interface
  // text is one family and never transformed, so shape tells them apart.
  expect(looks.tool.border).not.toBe('0px');
  expect(Number.parseFloat(looks.tool.radius)).toBeGreaterThan(100);
  expect(looks.toggleInToolGroup).toBe(false);
  expect(looks.roles).toEqual(['switch', 'switch']);
  expect(looks.toggle.border).toBe('0px');
  expect(looks.combine.radius).toBe('0px');
  expect(looks.combine.radius).not.toBe(looks.tool.radius);
  for (const look of [looks.tool, looks.toggle, looks.combine]) {
    expect(look.transform).toBe('none');
    expect(look.font).toBe(looks.tool.font);
  }
  expect(looks.barToggle).toEqual(looks.toggle);
  expect(looks.barCombine).toEqual(looks.combine);
  expect(looks.barTrack).toEqual(looks.track);
});
