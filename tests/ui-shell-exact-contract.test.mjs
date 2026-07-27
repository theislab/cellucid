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
const SPACING_TOKENS_URL = new URL(
  '../assets/css/tokens/_spacing.css',
  import.meta.url,
);
const RESPONSIVE_LAYOUT_URL = new URL(
  '../assets/css/layouts/_responsive.css',
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
  assert.match(source, /\['canvas', canvas\]/);
  assert.match(source, /onViewportOcclusionChange/);
  assert.match(source, /new ResizeObserver\(publishViewportOcclusion\)/);
  assert.match(source, /require the \$\{label\} HTMLElement/);
  assert.match(source, /elements from one document/);
  assert.doesNotMatch(source, /Math\.round\(initialWidth\)/);
  assert.doesNotMatch(source, /\btry\b|\bcatch\b|dom\?\.|return\s+\{\s*\}/);
});

test('user-resized desktop width cannot override responsive sidebar ownership', async () => {
  const [controls, tokens, responsive] = await Promise.all([
    readFile(SIDEBAR_CONTROLS_URL, 'utf8'),
    readFile(SPACING_TOKENS_URL, 'utf8'),
    readFile(RESPONSIVE_LAYOUT_URL, 'utf8'),
  ]);
  assert.match(controls, /'--sidebar-user-width'/);
  assert.doesNotMatch(controls, /setVariable\([\s\S]*?'--sidebar-width'/);
  assert.match(
    tokens,
    /--sidebar-width:\s*var\(--sidebar-user-width,\s*280px\)/,
  );
  assert.match(
    responsive,
    /@media \(max-width: 900px\)[\s\S]*?--sidebar-width:\s*260px/,
  );
  assert.match(
    responsive,
    /@media \(max-width: 720px\)[\s\S]*?--sidebar-width:\s*100vw/,
  );
  assert.match(
    responsive,
    /@media \(max-width: 900px\)[\s\S]*?#sidebar-resize-handle\s*\{[\s\S]*?display:\s*none/,
  );
  assert.match(controls, /matchMedia\('\(max-width: 900px\)'\)/);
  assert.match(
    controls,
    /if \(responsiveResizeMedia\.matches\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?return;/,
  );
  assert.doesNotMatch(controls, /min-width:\s*901px/);
});

test('sidebar drag publishes cached geometry without a synchronous layout read', async () => {
  const source = await readFile(SIDEBAR_CONTROLS_URL, 'utf8');
  const updateWidth = source.match(
    /const updateSidebarWidth = \(width\) => \{([\s\S]*?)\n  \};/,
  );
  assert.ok(updateWidth, 'sidebar width owner must remain explicit');
  assert.match(updateWidth[1], /StyleManager\.setVariable/);
  assert.doesNotMatch(updateWidth[1], /publishViewportOcclusion/);
  assert.match(
    updateWidth[1],
    /publishCachedViewportOcclusion\(clampedWidth\)/,
  );
  assert.doesNotMatch(updateWidth[1], /getBoundingClientRect|offsetWidth/);
  assert.match(source, /new ResizeObserver\(publishViewportOcclusion\)/);
});
