/**
 * The interface type scale and touch geometry ("Type scale" and "Rhythm and
 * touch" in assets/css/README.md), held at the source:
 *
 * - every component and layout `font-size` names a `--type-*` role (or a
 *   `--control-glyph-*` size for a glyph button), apart from listed plot
 *   content;
 * - the scale is flat: titles one step above the one size everything else
 *   is set in, secondary text one step below, badges one further, on a mouse
 *   layout and on a coarse pointer, and the coarse pointer never shrinks a
 *   role;
 * - interface text is one family, sentence case, never letter-spaced, and
 *   never bolder than semibold;
 * - the coarse pointer draws controls compact and reaches a fingertip
 *   through the hit extension, not through inflated boxes or 16px fields;
 * - the iOS focus-zoom bootstrap is the only viewport change, runs before
 *   the stylesheet, and touches the viewport on iOS WebKit only;
 * - component radii keep the one shape language (none, sm, full).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFile(path.join(ROOT, relative), 'utf8');

async function cssFiles(relativeDir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, relativeDir))) {
    if (entry.endsWith('.css') && entry !== '_index.css') {
      out.push(path.posix.join(relativeDir, entry));
    }
  }
  return out.sort();
}

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** `[selector, declarations]` for every rule body in a stylesheet. */
function rules(css) {
  const out = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of stripComments(css).matchAll(pattern)) {
    out.push([match[1].trim(), match[2]]);
  }
  return out;
}

function customProperties(block) {
  const out = new Map();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

const typography = await read('assets/css/tokens/_typography.css');
const responsive = await read('assets/css/layouts/_responsive.css');
const controlTokens = await read('assets/css/tokens/_controls.css');
const rootTokens = customProperties(stripComments(typography));
const textSteps = new Map(
  [...rootTokens].filter(([name]) => name.startsWith('--text-'))
    .map(([name, value]) => [name, Number.parseFloat(value)]),
);

function coarseRootBlock() {
  const css = stripComments(responsive);
  const start = css.indexOf('@media (pointer: coarse) {');
  assert.notEqual(start, -1, 'the coarse-pointer block exists');
  const rootStart = css.indexOf(':root {', start);
  const rootEnd = css.indexOf('}', rootStart);
  return customProperties(css.slice(rootStart, rootEnd));
}

/** Resolve a role's `var(--text-*)` to pixels. */
function px(value, label) {
  const match = /^var\((--text-[a-z0-9]+)\)$/.exec(value ?? '');
  assert.ok(match, `${label} is one --text-* step (got ${value})`);
  const size = textSteps.get(match[1]);
  assert.ok(Number.isFinite(size), `${match[1]} is defined`);
  return size;
}

const ROLES = [
  'title', 'heading', 'body', 'label', 'control', 'button', 'hint',
  'readout', 'compact',
];

function scale(properties, label) {
  const out = {};
  for (const role of ROLES) {
    out[role] = px(properties.get(`--type-${role}`), `${label} --type-${role}`);
  }
  return out;
}

function assertOrder(sizes, label) {
  // One size for the bulk of the interface: headings, body, labels, the text
  // inside controls and on buttons. Hierarchy above it is weight and colour.
  for (const role of ['heading', 'body', 'label', 'control', 'button']) {
    assert.equal(sizes[role], sizes.body, `${label}: ${role} is the base size`);
  }
  assert.equal(sizes.title - sizes.body, 1, `${label}: a title is one step above the base`);
  for (const small of ['hint', 'readout']) {
    assert.equal(sizes.body - sizes[small], 1, `${label}: ${small} is one step below the base`);
  }
  assert.equal(sizes.hint - sizes.compact, 1, `${label}: a badge is one step below secondary text`);
  assert.ok(sizes.title <= 14, `${label}: no interface text above 14px`);
  assert.ok(sizes.compact >= 10, `${label}: no interface text below 10px`);
}

test('the type roles keep their flat scale on a mouse and on a coarse pointer', () => {
  const mouse = scale(rootTokens, 'mouse');
  assertOrder(mouse, 'mouse');
  const coarseOverrides = coarseRootBlock();
  const coarse = scale(new Map([...rootTokens, ...coarseOverrides]), 'coarse');
  assertOrder(coarse, 'coarse');
  for (const role of ROLES) {
    assert.ok(coarse[role] >= mouse[role], `--type-${role} never shrinks on touch`);
    assert.ok(coarse[role] - mouse[role] <= 1, `--type-${role} rises at most one step`);
  }
});

const PLOT_CONTENT = new Set([
  // Centroid labels belong to the figure, which export reproduces.
  'assets/css/layouts/_app.css #label-layer',
]);

test('interface text names a type role, never a raw size or text step', async () => {
  const files = [
    ...await cssFiles('assets/css/components'),
    ...(await cssFiles('assets/css/layouts')).filter(file => !file.endsWith('_print.css')),
    ...await cssFiles('assets/css/base'),
    ...await cssFiles('assets/css/utilities'),
  ];
  const offenders = [];
  for (const file of files) {
    for (const [selector, body] of rules(await read(file))) {
      for (const match of body.matchAll(/(?:^|;|\s)font-size\s*:\s*([^;]+)/g)) {
        const value = match[1].trim();
        // A Plotly override needs !important to beat Plotly's inline styles.
        if (/^var\(--type-[a-z]+\)( !important)?$/.test(value)) continue;
        if (/^var\(--control-glyph-(sm|md|lg)\)$/.test(value)) continue;
        if (value === 'inherit') continue;
        if (PLOT_CONTENT.has(`${file} ${selector}`)) continue;
        offenders.push(`${file} ${selector} { font-size: ${value} }`);
      }
      if (/(?:^|;|\s)font\s*:(?!\s*inherit\s*(;|$))/.test(body)) {
        offenders.push(`${file} ${selector} sets the font shorthand`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('a glyph size is only ever a glyph button or icon', async () => {
  const users = [];
  for (const file of await cssFiles('assets/css/components')) {
    for (const [selector, body] of rules(await read(file))) {
      if (/font-size\s*:\s*var\(--control-glyph-/.test(body)) users.push(selector);
    }
  }
  for (const selector of users) {
    assert.match(
      selector,
      /::before|btn|close|toggle|icon|tab-combine|tab-delete|notification-dismiss/,
      `${selector} uses a glyph size`,
    );
  }
  assert.ok(users.length >= 6);
});

test('a coarse pointer draws controls compact and extends their hit area', () => {
  const coarse = coarseRootBlock();
  const mouse = customProperties(stripComments(controlTokens));
  assert.equal(mouse.get('--control-hit-extend'), '0px', 'a mouse layout has no extension');
  const drawn = /^var\((--space-[0-9-]+)\)$/.exec(coarse.get('--control-target-min'));
  assert.ok(drawn, 'the drawn touch height is a spacing token');
  const spacing = new Map([['--space-8', 32], ['--space-9', 36], ['--space-10', 40]]);
  const drawnPx = spacing.get(drawn[1]);
  assert.ok(drawnPx >= 32 && drawnPx <= 36, `controls are drawn 32-36px (got ${drawn[1]})`);
  assert.equal(coarse.get('--control-row-min'), coarse.get('--control-target-min'));
  const extend = Number.parseFloat(coarse.get('--control-hit-extend'));
  assert.ok(drawnPx + 2 * extend >= 42, 'the hit area reaches a fingertip');
  assert.ok(extend * 2 <= 6, 'two extensions fit in the stacked-control gap (--space-1-5)');
});

test('the hit extension is a pseudo-element on every leaf control', async () => {
  const buttons = stripComments(await read('assets/css/components/_buttons.css'));
  const controls = stripComments(await read('assets/css/components/_controls.css'));
  for (const selector of ['.btn::after', '.icon-btn::after', '.segmented-btn::after']) {
    assert.ok(buttons.includes(selector), `${selector} carries the extension`);
  }
  for (const selector of ['.checkbox-inline::after', '.switch::after']) {
    assert.ok(controls.includes(selector), `${selector} carries the extension`);
  }
  assert.match(buttons, /inset:\s*calc\(-1 \* \(var\(--control-hit-extend\)/);
  assert.match(controls, /inset:\s*calc\(-1 \* var\(--control-hit-extend\)\) 0/);
  // A one-line field takes the extension as transparent border on touch.
  const touchField = /@media \(pointer: coarse\) \{\s*\.obs-select:not\(textarea\) \{([^}]*)\}/.exec(controls);
  assert.ok(touchField, 'one-line fields have a touch rule');
  assert.match(touchField[1], /border-width:\s*var\(--control-hit-extend\) 0;/);
  assert.match(touchField[1], /background-clip:\s*padding-box;/);
  assert.match(touchField[1], /min-height:\s*calc\(var\(--control-target-min\) \+ 2 \* var\(--control-hit-extend\)\);/);
});

test('field text is never forced to 16px for touch screens', async () => {
  const offenders = [];
  for (const file of [
    ...await cssFiles('assets/css/components'),
    ...await cssFiles('assets/css/layouts'),
  ]) {
    if (/font-size\s*:\s*(16px|var\(--text-2xl\)|1rem)/.test(stripComments(await read(file)))) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

const indexHtml = await read('index.html');
const viewportInit = await read('assets/js/app/ui/core/viewport-init.js');

test('the iOS viewport bootstrap runs in the head, before the stylesheet', () => {
  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));
  const script = head.indexOf('<script src="assets/js/app/ui/core/viewport-init.js"></script>');
  const theme = head.indexOf('assets/js/app/ui/core/theme-init.js');
  const stylesheet = head.indexOf('<link rel="stylesheet" href="assets/css/main.css"');
  assert.ok(script > -1, 'viewport-init.js is loaded from the head');
  assert.ok(theme > -1 && theme < script, 'after the theme bootstrap');
  assert.ok(stylesheet > script, 'before the stylesheet');
  assert.match(
    head,
    /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/,
    'the authored viewport keeps pinch zoom',
  );
});

function runViewportInit({ supportsCallout, content = 'width=device-width, initial-scale=1.0' }) {
  const meta = {
    value: content,
    getAttribute: () => meta.value,
    setAttribute: (name, value) => {
      assert.equal(name, 'content');
      meta.value = value;
    },
  };
  const context = {
    document: { querySelector: selector => (selector === 'meta[name="viewport"]' ? meta : null) },
    CSS: { supports: (property, value) => property === '-webkit-touch-callout' && value === 'none' && supportsCallout },
  };
  vm.runInNewContext(viewportInit, context);
  return meta.value;
}

test('only iOS WebKit loses the focus zoom, once, and others keep pinch zoom', () => {
  assert.equal(
    runViewportInit({ supportsCallout: true }),
    'width=device-width, initial-scale=1.0, maximum-scale=1',
  );
  assert.equal(
    runViewportInit({ supportsCallout: false }),
    'width=device-width, initial-scale=1.0',
  );
  assert.equal(
    runViewportInit({ supportsCallout: true, content: 'width=device-width, maximum-scale=2' }),
    'width=device-width, maximum-scale=2',
  );
});

test('one shape language: square surfaces, slightly rounded badges, pill buttons', async () => {
  const offenders = [];
  for (const file of [
    ...await cssFiles('assets/css/components'),
    ...await cssFiles('assets/css/layouts'),
  ]) {
    for (const [selector, body] of rules(await read(file))) {
      for (const match of body.matchAll(/border-radius\s*:\s*([^;]+)/g)) {
        const parts = match[1].trim().split(/\s+/);
        if (parts.every(part => /^(0|var\(--radius-(none|sm|full)\))$/.test(part))) continue;
        offenders.push(`${file} ${selector} { border-radius: ${match[1].trim()} }`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

/** Every component and layout rule, with its file. */
async function interfaceRules() {
  const out = [];
  for (const file of [
    ...await cssFiles('assets/css/components'),
    ...(await cssFiles('assets/css/layouts')).filter(name => !name.endsWith('_print.css')),
    // `@font-face` names the face and its weight axis; it styles no text.
    ...(await cssFiles('assets/css/base')).filter(name => !name.endsWith('_fonts.css')),
  ]) {
    for (const [selector, body] of rules(await read(file))) out.push({ file, selector, body });
  }
  return out;
}

test('interface text is one family: Inter, with monospace only for code', async () => {
  const fonts = stripComments(await read('assets/css/base/_fonts.css'));
  assert.deepEqual(
    [...fonts.matchAll(/font-family:\s*'([^']+)'/g)].map(match => match[1]),
    ['Inter'],
    'the one self-hosted face is Inter',
  );
  assert.ok(!rootTokens.has('--font-display'), 'no display face is defined');
  const MONOSPACE = new Set(['code', '#benchmark-report-output']);
  const offenders = [];
  for (const { file, selector, body } of await interfaceRules()) {
    for (const match of body.matchAll(/font-family\s*:\s*([^;]+)/g)) {
      const value = match[1].trim();
      if (value === 'var(--font-sans)' || value === 'inherit') continue;
      if (value === 'var(--font-mono)' && MONOSPACE.has(selector)) continue;
      offenders.push(`${file} ${selector} { font-family: ${value} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('interface text is sentence case, not letter-spaced, and at most semibold', async () => {
  const offenders = [];
  for (const { file, selector, body } of await interfaceRules()) {
    if (/text-transform\s*:\s*(uppercase|capitalize)/.test(body)) {
      offenders.push(`${file} ${selector} transforms case`);
    }
    for (const match of body.matchAll(/letter-spacing\s*:\s*([^;]+)/g)) {
      const value = match[1].trim();
      if (['normal', 'inherit', '0', 'var(--tracking-normal)', 'var(--tracking-tight)'].includes(value)) continue;
      offenders.push(`${file} ${selector} { letter-spacing: ${value} }`);
    }
    for (const match of body.matchAll(/font-weight\s*:\s*([^;]+)/g)) {
      const value = match[1].trim();
      if (['inherit', 'var(--font-weight-regular)', 'var(--font-weight-medium)', 'var(--font-weight-semibold)'].includes(value)) continue;
      offenders.push(`${file} ${selector} { font-weight: ${value} }`);
    }
  }
  assert.deepEqual(offenders, []);
});
