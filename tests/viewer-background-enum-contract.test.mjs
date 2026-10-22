/**
 * Every owner of the viewer background enum agrees with
 * `assets/js/rendering/viewer-backgrounds.js`.
 *
 * The enum is restated where a module cannot be imported — the
 * `#background-select` options and `<html data-viewer-background>` default in
 * `index.html`, the classic bootstrap script `theme-init.js`, and the page
 * colours in `assets/css` — and imported everywhere else. A background added
 * to one place only would be a menu entry the renderer rejects, a stored
 * preference the bootstrap refuses, a seam between the page and the canvas,
 * or an export that cannot say what the viewer drew. Each case fails here.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  DEFAULT_VIEWER_BACKGROUND,
  GRID_VIEWER_BACKGROUNDS,
  LOOK_VIEWER_BACKGROUNDS,
  STUDIO_VIEWER_BACKGROUNDS,
  VIEWER_BACKGROUND_GROUPS,
  VIEWER_BACKGROUNDS,
  VIEWER_BACKGROUND_ERROR_MESSAGE,
  VIEWER_BACKGROUND_LABELS,
  isViewerBackground,
} from '../assets/js/rendering/viewer-backgrounds.js';
import { STUDIO_PALETTES, studioColor01 } from '../assets/js/rendering/studio-backdrop.js';
import { BACKDROP_LOOKS, BACKDROP_LOOK_IDS } from '../assets/js/rendering/backdrops/backdrop-looks.js';
import { assertViewerBackground } from '../assets/js/rendering/viewer/viewer-contracts.js';
import {
  readActiveReferenceGridAppearance,
  readActiveViewerBackground,
  VIEWER_BACKGROUND_LABELS as EXPORT_LABELS,
} from '../assets/js/app/ui/modules/figure-export/utils/viewer-background.js';

const repositoryRoot = new URL('../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, repositoryRoot), 'utf8');

function backgroundSelectOptions(html) {
  const select = html.match(/<select id="background-select"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'index.html must declare #background-select');
  return [...select[1].matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)]
    .map(([, value, selected, label]) => ({ value, selected: Boolean(selected), label }));
}

function hexOf(rgb8) {
  return `#${rgb8.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

test('the enum is twelve exact, distinct backgrounds in menu order', () => {
  assert.deepEqual(VIEWER_BACKGROUNDS, [
    'white',
    'grid',
    'studio',
    'atelier',
    'abyss',
    'aurora',
    'black',
    'grid-dark',
    'studio-dark',
    'nebula',
    'abyss-dark',
    'aurora-dark',
  ]);
  // The menu is grouped into Light and Dark, and the groups are the enum.
  assert.deepEqual(VIEWER_BACKGROUND_GROUPS.map((group) => group.label), ['Light', 'Dark']);
  assert.deepEqual(
    VIEWER_BACKGROUND_GROUPS.flatMap((group) => group.backgrounds),
    [...VIEWER_BACKGROUNDS],
  );
  assert.equal(DEFAULT_VIEWER_BACKGROUND, 'studio');
  assert.ok(Object.isFrozen(VIEWER_BACKGROUNDS));
  assert.deepEqual(Object.keys(VIEWER_BACKGROUND_LABELS), [...VIEWER_BACKGROUNDS]);
  assert.deepEqual([...LOOK_VIEWER_BACKGROUNDS].sort(), [...BACKDROP_LOOK_IDS].sort());
  for (const mode of LOOK_VIEWER_BACKGROUNDS) {
    assert.equal(VIEWER_BACKGROUND_LABELS[mode], BACKDROP_LOOKS[mode].label);
  }
  for (const family of [GRID_VIEWER_BACKGROUNDS, STUDIO_VIEWER_BACKGROUNDS, LOOK_VIEWER_BACKGROUNDS]) {
    for (const mode of family) assert.ok(isViewerBackground(mode));
  }
  assert.equal(isViewerBackground('Studio'), false);
  assert.equal(isViewerBackground(undefined), false);
});

test('the #background-select options are the enum, in order, with its labels', async () => {
  const html = await read('index.html');
  const options = backgroundSelectOptions(html);
  assert.deepEqual(options.map((option) => option.value), [...VIEWER_BACKGROUNDS]);
  for (const option of options) {
    assert.equal(option.label, VIEWER_BACKGROUND_LABELS[option.value]);
  }
  const selected = options.filter((option) => option.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].value, DEFAULT_VIEWER_BACKGROUND);
  const declared = html.match(/<html[^>]*data-viewer-background="([^"]+)"/);
  assert.ok(declared, 'index.html must declare the bootstrap background');
  assert.equal(declared[1], DEFAULT_VIEWER_BACKGROUND);
  // Each <optgroup> holds exactly its group's backgrounds, in order.
  const select = html.match(/<select id="background-select"[^>]*>([\s\S]*?)<\/select>/)[1];
  const groups = [...select.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)]
    .map(([, label, body]) => ({
      label,
      backgrounds: [...body.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value),
    }));
  assert.deepEqual(groups, VIEWER_BACKGROUND_GROUPS.map((group) => ({
    label: group.label,
    backgrounds: [...group.backgrounds],
  })));
});

test('the bootstrap script accepts exactly the enum', async () => {
  const source = await read('assets/js/app/ui/core/theme-init.js');
  const run = (stored) => {
    const root = { dataset: { theme: 'light', viewerBackground: 'grid' } };
    const context = {
      document: { documentElement: root, body: { dataset: {} } },
      localStorage: {
        getItem: (key) => (key === 'cellucid_viewer_background' ? stored : null),
      },
    };
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return { root, failure: context.__cellucidThemeBootstrapFailure };
  };
  for (const mode of VIEWER_BACKGROUNDS) {
    const { root, failure } = run(mode);
    assert.equal(failure, undefined, `bootstrap rejected "${mode}"`);
    assert.equal(root.dataset.viewerBackground, mode);
  }
  const { failure } = run('sepia');
  // The bootstrap runs in its own realm, so its TypeError is that realm's.
  assert.equal(failure?.name, 'TypeError');
  for (const mode of VIEWER_BACKGROUNDS) {
    assert.match(failure.message, new RegExp(`"${mode}"`));
  }
});

test('the renderer boundary accepts exactly the enum', () => {
  for (const mode of VIEWER_BACKGROUNDS) {
    assert.equal(assertViewerBackground(mode), mode);
  }
  for (const value of ['sepia', '', null, 'Grid', 'studio-light']) {
    assert.throws(() => assertViewerBackground(value), {
      message: VIEWER_BACKGROUND_ERROR_MESSAGE,
    });
  }
});

test('module owners import the enum instead of restating it', async () => {
  for (const relativePath of [
    'assets/js/rendering/viewer/viewer-contracts.js',
    'assets/js/app/ui/modules/render-controls.js',
    'assets/js/app/ui/modules/visualization-reset.js',
    'assets/js/app/ui/modules/figure-export/utils/viewer-background.js',
  ]) {
    const source = await read(relativePath);
    assert.match(source, /\/viewer-backgrounds\.js';/, relativePath);
    assert.doesNotMatch(
      source,
      /\[\s*'(?:white|grid|black)',\s*'(?:grid|grid-dark|white)'/,
      `${relativePath} restates the background list`
    );
  }
});

test('every background has a page colour, and studio pages match the canvas exactly', async () => {
  const globalCss = await read('assets/css/base/_global.css');
  const tokens = await read('assets/css/tokens/_colors.css');
  const typings = await read('types/design-tokens.d.ts');
  const tokenValue = (name) => {
    const match = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`));
    assert.ok(match, `missing --${name}`);
    return match[1];
  };
  for (const mode of VIEWER_BACKGROUNDS) {
    assert.match(
      globalCss,
      new RegExp(`:root\\[data-viewer-background="${mode}"\\] body \\{ background: var\\(--[a-z-]+\\); \\}`),
      `no page colour for "${mode}"`
    );
  }
  for (const mode of STUDIO_VIEWER_BACKGROUNDS) {
    const token = `viewer-bg-${mode}`;
    assert.match(globalCss, new RegExp(`data-viewer-background="${mode}"\\] body \\{ background: var\\(--${token}\\)`));
    // The canvas is cleared to the palette surface; the page must be the
    // same 8-bit colour or a seam shows at the canvas edge while loading.
    assert.equal(tokenValue(token), hexOf(STUDIO_PALETTES[mode].surface));
    assert.match(typings, new RegExp(`'${token}'`));
  }
  // A baked look clears to its surface; the page is the same colour.
  for (const mode of LOOK_VIEWER_BACKGROUNDS) {
    const token = `viewer-bg-${mode}`;
    assert.match(globalCss, new RegExp(`data-viewer-background="${mode}"\\] body \\{ background: var\\(--${token}\\)`));
    assert.equal(tokenValue(token), hexOf(BACKDROP_LOOKS[mode].surface));
    assert.match(typings, new RegExp(`'${token}'`));
  }
});

test('figure export reads every background and knows which layer each draws', () => {
  assert.equal(EXPORT_LABELS, VIEWER_BACKGROUND_LABELS);
  const documentWith = (value) => ({
    getElementById: (id) => (id === 'background-select' ? { value } : null),
  });
  for (const mode of VIEWER_BACKGROUNDS) {
    assert.equal(readActiveViewerBackground(documentWith(mode)), mode);
    const appearance = readActiveReferenceGridAppearance(documentWith(mode));
    if (GRID_VIEWER_BACKGROUNDS.includes(mode)) {
      assert.equal(appearance.kind, 'grid');
    } else if (STUDIO_VIEWER_BACKGROUNDS.includes(mode)) {
      assert.equal(appearance.kind, 'studio');
      assert.equal(appearance.palette, STUDIO_PALETTES[mode]);
      assert.deepEqual([...appearance.surfaceColor], studioColor01(STUDIO_PALETTES[mode].surface));
    } else if (LOOK_VIEWER_BACKGROUNDS.includes(mode)) {
      // A look is redrawn as a raster from the pane's frozen state; the
      // appearance names it and its surface.
      assert.equal(appearance.kind, 'look');
      assert.equal(appearance.mode, mode);
      assert.deepEqual([...appearance.surfaceColor], BACKDROP_LOOKS[mode].surface.map((c) => c / 255));
    } else {
      assert.equal(appearance, null);
    }
  }
});

test('the viewer clears to the studio surface it publishes', async () => {
  const viewerSource = await read('assets/js/rendering/viewer.js');
  const studioCase = viewerSource.slice(
    viewerSource.indexOf("case 'studio':"),
    viewerSource.indexOf("case 'black':")
  );
  assert.match(studioCase, /case 'studio-dark': \{/);
  assert.match(studioCase, /studioPalette = STUDIO_PALETTES\[exactMode\];/);
  assert.match(studioCase, /gl\.clearColor\(surface\[0\], surface\[1\], surface\[2\], 1\);/);
  assert.match(studioCase, /bgColor = surface;/);
});
