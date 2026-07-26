import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  clampSidebarWidthPx,
} from '../assets/js/app/sidebar-metrics.js';

const SIDEBAR_CONTROLS_URL = new URL(
  '../assets/js/app/ui/modules/sidebar-controls.js',
  import.meta.url,
);

test('sidebar width accepts only finite numeric input before applying UI bounds', () => {
  for (const value of [undefined, null, '320', Number.NaN, Infinity, -Infinity]) {
    assert.throws(
      () => clampSidebarWidthPx(value),
      /finite number/i,
    );
  }
  assert.equal(clampSidebarWidthPx(1), SIDEBAR_MIN_WIDTH_PX);
  assert.equal(clampSidebarWidthPx(320.5), 320.5);
  assert.equal(clampSidebarWidthPx(10_000), SIDEBAR_MAX_WIDTH_PX);
});

test('sidebar initialization has one required DOM contract and propagates failures', async () => {
  const source = await readFile(SIDEBAR_CONTROLS_URL, 'utf8');
  assert.match(source, /\['sidebar', sidebar\]/);
  assert.match(source, /\['sidebar toggle', sidebarToggle\]/);
  assert.match(source, /\['sidebar resize handle', sidebarResizeHandle\]/);
  assert.match(source, /require the \$\{label\} HTMLElement/);
  assert.match(source, /elements from one document/);
  assert.doesNotMatch(source, /\btry\b|\bcatch\b|dom\?\.|return\s+\{\s*\}/);
});
