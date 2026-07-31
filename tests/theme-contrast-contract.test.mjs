import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PRIMITIVES_URL = new URL('../assets/css/tokens/_colors.css', import.meta.url);
const THEME_URLS = Object.freeze({
  light: new URL('../assets/css/themes/_light.css', import.meta.url),
  dark: new URL('../assets/css/themes/_dark.css', import.meta.url),
});

/* The surfaces that carry body copy. `--color-surface-tertiary` and
   `--color-border-light` are deliberately excluded: they are hover fills and
   chip backgrounds, not text surfaces, and no muted-text token clears 4.5:1
   against them in either theme. `--color-surface-sunken` and
   `--color-surface-inverse` are excluded because inverse text tokens are used
   on them. */
const TEXT_TOKENS = Object.freeze([
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-tertiary',
]);
const TEXT_SURFACES = Object.freeze([
  '--color-surface-primary',
  '--color-surface-secondary',
  '--color-surface-elevated',
]);

/* WCAG 2.2 SC 1.4.3 Contrast (Minimum), AA. Every element measured in the
   OBJ-8 audit renders below 18.66px bold / 24px regular, so the normal-text
   threshold applies to all of them, not the 3:1 large-text threshold. */
const NORMAL_TEXT_MINIMUM = 4.5;

function parseDeclarations(css) {
  const declarations = new Map();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+);/gi)) {
    const name = match[1];
    const value = match[2].trim();
    if (declarations.has(name)) {
      throw new Error(`Token ${name} is declared more than once in one file`);
    }
    declarations.set(name, value);
  }
  return declarations;
}

function resolve(name, theme, primitives) {
  const seen = new Set();
  let value = theme.get(name) ?? primitives.get(name);
  while (typeof value === 'string' && value.startsWith('var(')) {
    const referenced = value.slice(4, -1).trim();
    if (seen.has(referenced)) throw new Error(`Token cycle at ${referenced}`);
    seen.add(referenced);
    value = theme.get(referenced) ?? primitives.get(referenced);
  }
  if (typeof value !== 'string') {
    throw new Error(`Token ${name} does not resolve to a value`);
  }
  return value;
}

function toRgb(value) {
  const hex = value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`Expected a six-digit hex primitive, received "${value}"`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function relativeLuminance([r, g, b]) {
  const channel = value => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const primitives = parseDeclarations(await readFile(PRIMITIVES_URL, 'utf8'));
const themes = new Map();
for (const [name, url] of Object.entries(THEME_URLS)) {
  themes.set(name, parseDeclarations(await readFile(url, 'utf8')));
}

test('every theme resolves the full text and surface token set to a primitive hex', () => {
  for (const [themeName, theme] of themes) {
    for (const token of [...TEXT_TOKENS, ...TEXT_SURFACES]) {
      assert.equal(
        theme.has(token),
        true,
        `${themeName} theme must declare ${token} itself, not inherit it`,
      );
      assert.doesNotThrow(
        () => toRgb(resolve(token, theme, primitives)),
        `${themeName} ${token} must resolve to a hex primitive`,
      );
    }
  }
});

test('text tokens clear WCAG AA normal-text contrast on every text surface in every theme', () => {
  const failures = [];
  for (const [themeName, theme] of themes) {
    for (const textToken of TEXT_TOKENS) {
      const foreground = toRgb(resolve(textToken, theme, primitives));
      for (const surfaceToken of TEXT_SURFACES) {
        const background = toRgb(resolve(surfaceToken, theme, primitives));
        const ratio = contrastRatio(foreground, background);
        if (ratio < NORMAL_TEXT_MINIMUM) {
          failures.push(
            `${themeName}: ${textToken} on ${surfaceToken} = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `Token pairs below ${NORMAL_TEXT_MINIMUM}:1:\n${failures.join('\n')}`,
  );
});

test('the muted text token stays a distinct step from the secondary text token', () => {
  for (const [themeName, theme] of themes) {
    const secondary = resolve('--color-text-secondary', theme, primitives);
    const tertiary = resolve('--color-text-tertiary', theme, primitives);
    assert.notEqual(
      secondary,
      tertiary,
      `${themeName} theme collapsed the secondary/tertiary text ramp`,
    );
    const ratio = contrastRatio(toRgb(tertiary), toRgb(secondary));
    assert.ok(
      ratio > 1,
      `${themeName} theme must keep tertiary text lighter or darker than secondary`,
    );
  }
});
