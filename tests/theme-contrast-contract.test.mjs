import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const PRIMITIVES_URL = new URL('../assets/css/tokens/_colors.css', import.meta.url);
const COMPONENTS_DIR_URL = new URL('../assets/css/components/', import.meta.url);
const THEME_URLS = Object.freeze({
  light: new URL('../assets/css/themes/_light.css', import.meta.url),
  dark: new URL('../assets/css/themes/_dark.css', import.meta.url),
});

/* One convention for status colour, measured rather than assumed:
   `--color-<status>` is a fill or a border, `--color-<status>-text` is the
   only status token allowed to colour glyphs. The saturated tokens sink well
   below AA as text in the light theme (`--color-warning` reaches 1.74:1 on
   `--color-surface-tertiary`) while passing comfortably in dark, so a
   dark-only review will not catch a regression here. */
const STATUS_NAMES = Object.freeze(['success', 'warning', 'danger', 'info']);

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

const componentStylesheets = new Map();
for (const entry of (await readdir(COMPONENTS_DIR_URL, { withFileTypes: true }))
  .filter(candidate => candidate.isFile() && candidate.name.endsWith('.css'))
  .sort((a, b) => a.name.localeCompare(b.name))) {
  componentStylesheets.set(
    entry.name,
    await readFile(new URL(entry.name, COMPONENTS_DIR_URL), 'utf8'),
  );
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

test('components colour status text with the -text token, never the saturated fill', () => {
  const offenders = [];
  for (const [fileName, css] of componentStylesheets) {
    const lines = css.split('\n');
    for (const [index, line] of lines.entries()) {
      const match = line.match(
        new RegExp(`^\\s*color:\\s*var\\(--color-(${STATUS_NAMES.join('|')})\\)\\s*;`),
      );
      if (match !== null) {
        offenders.push(
          `${fileName}:${index + 1} uses --color-${match[1]} as a text colour;`
          + ` use --color-${match[1]}-text`,
        );
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('every status text token clears AA on the surfaces status panels use', () => {
  /* Status panels tint a surface and put status text on it. Both the neutral
     panel surfaces and the matching `-soft` fill have to carry that text.
     `--color-surface-tertiary` and `--color-border-light` stay out for the
     same reason the neutral ramp excludes them: they are hover and chip
     fills. `--color-warning-text` reaches only 4.47:1 on the light tertiary
     surface, which is why .bn-fps-row is built on --color-surface-secondary. */
  const failures = [];
  for (const [themeName, theme] of themes) {
    for (const status of STATUS_NAMES) {
      const foreground = toRgb(resolve(`--color-${status}-text`, theme, primitives));
      const backgrounds = TEXT_SURFACES.map(
        token => [token, toRgb(resolve(token, theme, primitives))],
      );
      /* Dark declares `-soft` as color-mix(<status> 12%, transparent), so
         composite it over each panel surface rather than assuming a hex. */
      const softValue = resolve(`--color-${status}-soft`, theme, primitives);
      const softMix = softValue.match(
        /^color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*(\d+)%,\s*transparent\)$/i,
      );
      if (softMix === null) {
        backgrounds.push([`--color-${status}-soft`, toRgb(softValue)]);
      } else {
        const tint = toRgb(resolve(softMix[1], theme, primitives));
        const alpha = Number(softMix[2]) / 100;
        for (const [surfaceToken, surface] of [...backgrounds]) {
          backgrounds.push([
            `--color-${status}-soft over ${surfaceToken}`,
            tint.map((channel, index) => Math.round(
              channel * alpha + surface[index] * (1 - alpha),
            )),
          ]);
        }
      }

      for (const [label, background] of backgrounds) {
        const ratio = contrastRatio(foreground, background);
        if (ratio < NORMAL_TEXT_MINIMUM) {
          failures.push(
            `${themeName}: --color-${status}-text on ${label} = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `Status text pairs below ${NORMAL_TEXT_MINIMUM}:1:\n${failures.join('\n')}`,
  );
});
