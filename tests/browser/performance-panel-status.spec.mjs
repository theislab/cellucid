import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=performance-panel-ci';

const STATUSES = Object.freeze(['good', 'warning', 'danger']);

/* WCAG 2.2 SC 1.4.3 Contrast (Minimum), AA: 4.5:1 for normal text, 3:1 once
   the text reaches 24px, or 18.66px when bold. */
function requiredRatio(fontSize, fontWeight) {
  const size = Number.parseFloat(fontSize);
  const bold = Number.parseInt(fontWeight, 10) >= 700;
  return size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
}

/* Installs measurement helpers that composite the real ancestor background
   chain on a canvas, so color-mix()/color(srgb …) values need no parsing. */
function installProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  const paint = (color) => {
    context.fillStyle = '#ff00ff';
    context.fillStyle = color;
    if (context.fillStyle === '#ff00ff') {
      throw new Error(`Canvas could not resolve the CSS colour "${color}"`);
    }
    context.fillRect(0, 0, 1, 1);
  };
  const readPixel = () => {
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  };

  window.__measureContrast = (selector) => {
    const element = document.querySelector(selector);
    if (element === null) {
      throw new Error(`Missing measurement target ${selector}`);
    }
    const chain = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      chain.push(node);
    }
    context.clearRect(0, 0, 1, 1);
    paint('#ffffff');
    for (const node of chain.reverse()) {
      const background = getComputedStyle(node).backgroundColor;
      if (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') {
        continue;
      }
      paint(background);
    }
    const background = readPixel();
    const style = getComputedStyle(element);
    paint(style.color);
    const foreground = readPixel();

    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]) => (
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    );
    const a = luminance(foreground);
    const b = luminance(background);

    return {
      selector,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      foreground: `rgb(${foreground.join(', ')})`,
      background: `rgb(${background.join(', ')})`,
      ratio: Number(
        (((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))).toFixed(2)
      )
    };
  };
}

function revealResults() {
  const results = document.getElementById('bottleneck-results');
  for (let node = results; node; node = node.parentElement) {
    if (node.localName === 'details') node.open = true;
  }
  results.style.display = 'block';
  document.getElementById('bn-fps').textContent = '42';
}

for (const theme of ['light', 'dark']) {
  test(`the performance verdict panel is legible and emoji-free in ${theme}`, async ({
    page
  }) => {
    const productErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') productErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', error => {
      productErrors.push(`page: ${error.stack || error.message}`);
    });

    await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture'
    );
    await page.locator('#theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // themes/_base.css transitions every element during a theme change, so
    // computed colours are in flight until that class is gone.
    await expect(page.locator('html')).not.toHaveClass(/theme-transition/);
    await page.waitForTimeout(500);

    await page.evaluate(installProbe);
    await page.evaluate(revealResults);

    const failures = [];
    for (const status of STATUSES) {
      await page.evaluate((value) => {
        document.getElementById('bn-verdict-box').dataset.status = value;
        document.getElementById('bn-fps').dataset.status = value;
      }, status);
      await page.waitForTimeout(400);

      // Exactly one status glyph is shown, and it strokes with the verdict
      // colour rather than an emoji's fixed rendering.
      const shown = await page.locator('.bn-verdict-glyph:visible').evaluateAll(
        glyphs => glyphs.map(glyph => glyph.dataset.status)
      );
      expect(shown, `${theme}/${status} glyph`).toEqual([status]);
      const stroke = await page
        .locator(`.bn-verdict-glyph[data-status="${status}"]`)
        .evaluate(glyph => getComputedStyle(glyph).stroke);
      const verdictColor = await page
        .locator('#bn-verdict-box')
        .evaluate(box => getComputedStyle(box).color);
      expect(stroke, `${theme}/${status} stroke tracks currentColor`).toBe(
        verdictColor
      );

      for (const selector of [
        '#bn-verdict-title',
        '#bn-verdict-detail',
        '#bn-fps',
        '.bn-fps-label',
        '.bn-fps-suffix',
        '.bn-section-title'
      ]) {
        const cell = await page.evaluate(
          target => window.__measureContrast(target),
          selector
        );
        const minimum = requiredRatio(cell.fontSize, cell.fontWeight);
        if (cell.ratio < minimum) {
          failures.push(
            `${theme}/${status} ${selector}: ${cell.ratio}:1 < ${minimum}:1`
            + ` (${cell.foreground} on ${cell.background}, ${cell.fontSize}/${cell.fontWeight})`
          );
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);

    // No emoji anywhere in the panel: a screen reader announces them by name
    // and they ignore the theme's colour.
    const emoji = await page.locator('#bottleneck-results').evaluate(
      root => (root.textContent || '').match(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu
      ) || []
    );
    expect(emoji).toEqual([]);

    expect(productErrors).toEqual([]);
  });
}
