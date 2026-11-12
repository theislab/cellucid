/**
 * R9F-13 (fields-legend lane, 2026-11-11): with Select mode on, each tool's
 * step line still said "Alt to intersect, Shift+Alt to add, Ctrl+Alt to
 * subtract" while the switch's Intersect / Add / Subtract chose the combine.
 * The sentence was typed in four tools; it is one helper, and the line shown
 * follows the switch at once (CSS on the section's switch, no new gesture).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { combineHelpHtml, COMBINE_KEYS_COPY, COMBINE_SELECT_MODE_COPY } from '../assets/js/app/ui/modules/highlight/mode-copy.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the help holds both lines: the keys and Select mode', () => {
  assert.equal(
    combineHelpHtml(),
    `<span class="combine-help-keys">${COMBINE_KEYS_COPY.range}</span><span class="combine-help-select">${COMBINE_SELECT_MODE_COPY}</span>`,
  );
  assert.match(combineHelpHtml({ categorical: true }), /Alt to replace/);
});

test('no selection tool types the key sentence itself', async () => {
  for (const tool of ['knn', 'proximity', 'lasso', 'annotation']) {
    const source = await read(`assets/js/app/ui/modules/highlight/${tool}-selection.js`);
    assert.doesNotMatch(source, /Shift\+Alt to add/, tool);
    assert.match(source, /combineHelpHtml\(/, tool);
  }
});

test('the line shown follows the Select mode switch', async () => {
  const css = await read('assets/css/components/_filters.css');
  assert.match(css, /\.combine-help-select\s*\{\s*display: none;/);
  assert.match(css, /#highlighted-cells-section:has\(#highlight-select-mode\[aria-checked="true"\]\) \.combine-help-keys\s*\{\s*display: none;/);
  assert.match(css, /#highlighted-cells-section:has\(#highlight-select-mode\[aria-checked="true"\]\) \.combine-help-select\s*\{\s*display: inline;/);
  const html = await read('index.html');
  // Both inside the section the rule is written on.
  const section = html.slice(html.indexOf('id="highlighted-cells-section"'), html.indexOf('id="page-analysis-section"'));
  assert.match(section, /id="highlight-mode-description"/);
  assert.match(section, /id="highlight-select-mode"/);
});
