import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=slider-focus-and-target-ci';

/* WCAG 2.2 SC 2.5.8 Target Size (Minimum). */
const MINIMUM_TARGET_SIZE = 24;
/* The painted thumb is --space-3-5 (14px) across; the pointer target has to
   cover at least what the user can see, or the control lies about where it can
   be clicked (CEL-AUDIT-0084). */
const PAINTED_THUMB_SIZE = 14;

const SLIDERS = Object.freeze(['#point-size', '#lighting-strength', '#fog-density']);
const THEMES = Object.freeze(['light', 'dark']);

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
  });
  return errors;
}

async function installPixelDecoder(page) {
  await page.evaluate(() => {
    window.__decodePng = async base64 => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return Array.from(
        context.getImageData(0, 0, image.width, image.height).data
      );
    };
  });
}

async function decode(page, buffer) {
  return page.evaluate(
    base64 => window.__decodePng(base64),
    buffer.toString('base64')
  );
}

function countDifferingPixels(before, after) {
  expect(before.length).toBe(after.length);
  let differing = 0;
  for (let index = 0; index < before.length; index += 4) {
    if (
      before[index] !== after[index] ||
      before[index + 1] !== after[index + 1] ||
      before[index + 2] !== after[index + 2] ||
      before[index + 3] !== after[index + 3]
    ) differing += 1;
  }
  return differing;
}

test('range sliders paint a keyboard focus ring and accept pointer input across the whole thumb', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
  await installPixelDecoder(page);

  for (const theme of THEMES) {
    await page.locator('#theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    for (const selector of SLIDERS) {
      const slider = page.locator(selector);
      await slider.scrollIntoViewIfNeeded();

      const geometry = await slider.evaluate(element => {
        const box = element.getBoundingClientRect();
        const row = element.closest('.slider-row').getBoundingClientRect();
        return { height: box.height, width: box.width, rowHeight: row.height };
      });
      expect(
        geometry.height,
        `${theme} ${selector} pointer target height`
      ).toBeGreaterThanOrEqual(MINIMUM_TARGET_SIZE);
      expect(
        geometry.width,
        `${theme} ${selector} pointer target width`
      ).toBeGreaterThanOrEqual(MINIMUM_TARGET_SIZE);
      /* The 24px target must come from negative block margins, not from an
         inflated row: this panel's information density depends on it. */
      expect(
        geometry.rowHeight,
        `${theme} ${selector} row must not grow to fit the target`
      ).toBeLessThan(MINIMUM_TARGET_SIZE);

      const box = await slider.boundingBox();
      const clip = {
        x: Math.max(0, Math.floor(box.x - 8)),
        y: Math.max(0, Math.floor(box.y - 8)),
        width: Math.ceil(box.width + 16),
        height: Math.ceil(box.height + 16)
      };
      await page.evaluate(() => document.activeElement?.blur?.());
      const unfocused = await decode(page, await page.screenshot({ clip }));

      await slider.evaluate(element => element.focus({ focusVisible: true }));
      const focusState = await slider.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          isActive: document.activeElement === element,
          matchesFocusVisible: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth
        };
      });
      expect(focusState.isActive, `${theme} ${selector} focus`).toBe(true);
      expect(focusState.matchesFocusVisible).toBe(true);
      expect(
        focusState.outlineStyle,
        `CEL-AUDIT-0077: ${theme} ${selector} suppressed its focus ring`
      ).toBe('solid');
      expect(focusState.outlineWidth).toBe('2px');

      const focused = await decode(page, await page.screenshot({ clip }));
      const differing = countDifferingPixels(unfocused, focused);
      expect(
        differing,
        `CEL-AUDIT-0077: ${theme} ${selector} focus produced no visible pixels`
      ).toBeGreaterThan(0);
      await page.evaluate(() => document.activeElement?.blur?.());
    }
  }

  await page.locator('#theme-select').selectOption('light');

  /* Behavioural proof for CEL-AUDIT-0084: before the fix a click at the bottom
     edge of the painted thumb landed on the parent container and moved
     nothing. */
  const slider = page.locator('#point-size');
  await slider.scrollIntoViewIfNeeded();
  const offsets = [-(PAINTED_THUMB_SIZE / 2 - 1), 0, PAINTED_THUMB_SIZE / 2 - 1];
  for (const offset of offsets) {
    await slider.evaluate(element => {
      element.value = element.min;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const box = await slider.boundingBox();
    await page.mouse.click(
      box.x + box.width * 0.75,
      box.y + box.height / 2 + offset
    );
    await expect
      .poll(
        () => slider.inputValue(),
        {
          message:
            `CEL-AUDIT-0084: a click ${offset}px from the track centre is `
            + 'inside the painted thumb but did not reach the slider'
        }
      )
      .not.toBe(await slider.evaluate(element => element.min));
  }

  expect(productErrors).toEqual([]);
});
