/**
 * `assets/css/README.md` states the rule plainly: "No inline styles in
 * `index.html`. Use utilities + component classes."
 *
 * No presentational declaration in index.html is inline: each is a utility
 * class. The three elements whose initial `display: none` is not written
 * inline (the vector-field overlay block,
 * its settings and the Camera Path "Set all" row) start with the `hidden`
 * attribute instead, which their modules toggle, so no exemption remains.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INDEX_URL = new URL('../index.html', import.meta.url);
const LAYOUT_UTILITIES_URL = new URL(
  '../assets/css/utilities/_layout.css',
  import.meta.url
);
const SPACING_UTILITIES_URL = new URL(
  '../assets/css/utilities/_spacing.css',
  import.meta.url
);
/** Utility classes index.html leans on instead of an inline declaration. */
const REQUIRED_UTILITIES = Object.freeze({
  'w-full': LAYOUT_UTILITIES_URL,
  'd-flex': LAYOUT_UTILITIES_URL,
  'items-center': LAYOUT_UTILITIES_URL,
  'gap-1-5': LAYOUT_UTILITIES_URL,
  'm-0': SPACING_UTILITIES_URL
});

const indexSource = await readFile(INDEX_URL, 'utf8');
const indexHtml = indexSource.replace(/<!--[\s\S]*?-->/g, '');

test('index.html carries no inline style at all', () => {
  const inlineStyled = Array.from(
    indexHtml.matchAll(/<(\w+)\b[^>]*\bstyle="([^"]*)"[^>]*>/g),
    ([element, tagName]) => `<${tagName}> ${element.slice(0, 80)}`
  );
  assert.deepEqual(inlineStyled, [], 'move each declaration onto a class or the hidden attribute');
});

test('the modules that show and hide former inline-display blocks use hidden', async () => {
  for (const [file, pattern] of [
    ['../assets/js/app/ui/modules/velocity-overlay-controls.js', /controlBlock\.hidden = /],
    ['../assets/js/app/ui/modules/velocity-overlay-controls.js', /settings\.hidden = /],
    ['../assets/js/app/ui/modules/cinematic-camera/index.js', /timingActions\.hidden = /]
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, pattern);
    assert.doesNotMatch(source, /\.style\.display\s*=/, `${file} must not write an inline display`);
  }
});

test('every utility index.html now relies on exists', async () => {
  const sources = new Map();
  for (const [className, cssUrl] of Object.entries(REQUIRED_UTILITIES)) {
    if (!sources.has(cssUrl)) sources.set(cssUrl, await readFile(cssUrl, 'utf8'));
    assert.match(
      sources.get(cssUrl),
      new RegExp(`^\\.${className.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{`, 'm'),
      `index.html uses .${className}, which must be defined`
    );
    assert.match(
      indexHtml,
      new RegExp(`class="[^"]*\\b${className}\\b`),
      `.${className} is listed as required but index.html does not use it`
    );
  }
});
