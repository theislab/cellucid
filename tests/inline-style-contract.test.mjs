/**
 * `assets/css/README.md` states the rule plainly: "No inline styles in
 * `index.html`. Use utilities + component classes." (CEL-AUDIT-0101)
 *
 * Every presentational declaration index.html used to carry inline is now a
 * utility class that already existed. What remains is a short, explicit list of
 * elements whose `display` is written by application code at runtime; a
 * utility class cannot replace those, because the utilities are `!important`
 * and would win against the JavaScript that has to be able to show them again.
 * Each one is asserted to be owned by the module that toggles it, so the list
 * cannot quietly grow.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INDEX_URL = new URL('../index.html', import.meta.url);
const CSS_README_URL = new URL('../assets/css/README.md', import.meta.url);
const LAYOUT_UTILITIES_URL = new URL(
  '../assets/css/utilities/_layout.css',
  import.meta.url
);
const SPACING_UTILITIES_URL = new URL(
  '../assets/css/utilities/_spacing.css',
  import.meta.url
);
const TYPOGRAPHY_UTILITIES_URL = new URL(
  '../assets/css/utilities/_typography.css',
  import.meta.url
);
const VELOCITY_CONTROLS_URL = new URL(
  '../assets/js/app/ui/modules/velocity-overlay-controls.js',
  import.meta.url
);
const CINEMATIC_CAMERA_URL = new URL(
  '../assets/js/app/ui/modules/cinematic-camera/index.js',
  import.meta.url
);

/**
 * Elements whose inline `display` is a runtime-owned initial state, mapped to
 * the module that writes it.
 */
const RUNTIME_DISPLAY = Object.freeze({
  'velocity-overlay-controls': VELOCITY_CONTROLS_URL,
  'velocity-overlay-settings': VELOCITY_CONTROLS_URL,
  'cinematic-timing-actions': CINEMATIC_CAMERA_URL
});

/** Utility classes index.html leans on instead of an inline declaration. */
const REQUIRED_UTILITIES = Object.freeze({
  'w-full': LAYOUT_UTILITIES_URL,
  'd-flex': LAYOUT_UTILITIES_URL,
  'items-center': LAYOUT_UTILITIES_URL,
  'gap-1-5': LAYOUT_UTILITIES_URL,
  'm-0': SPACING_UTILITIES_URL,
  'mt-0': SPACING_UTILITIES_URL,
  'mt-1-5': SPACING_UTILITIES_URL,
  'font-medium': TYPOGRAPHY_UTILITIES_URL
});

const [indexSource, cssReadme] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(CSS_README_URL, 'utf8')
]);
const indexHtml = indexSource.replace(/<!--[\s\S]*?-->/g, '');

test('the rule this test enforces is the one the design system states', () => {
  assert.match(cssReadme, /No inline styles in `index\.html`/);
});

test('index.html carries no inline style but the runtime-owned display flags', async () => {
  const inlineStyled = Array.from(
    indexHtml.matchAll(/<(\w+)\b([^>]*\bstyle="([^"]*)"[^>]*)>/g)
  ).map(([, tagName, attributes, declarations]) => ({
    tagName,
    id: attributes.match(/(?:^|\s)id="([^"]*)"/)?.[1] ?? null,
    declarations: declarations.trim()
  }));

  for (const element of inlineStyled) {
    assert.ok(
      element.id !== null && Object.hasOwn(RUNTIME_DISPLAY, element.id),
      `<${element.tagName}> carries the inline style "${element.declarations}"; ` +
      'move it onto a utility or component class'
    );
    assert.match(
      element.declarations,
      /^display:\s*none;?$/,
      `#${element.id} may only carry its initial display state inline`
    );
  }

  assert.deepEqual(
    inlineStyled.map(element => element.id).sort(),
    Object.keys(RUNTIME_DISPLAY).sort()
  );

  // Each exemption has to be earned: the module named must actually write the
  // element's display, or the inline style is simply stale.
  for (const [id, moduleUrl] of Object.entries(RUNTIME_DISPLAY)) {
    const source = await readFile(moduleUrl, 'utf8');
    assert.match(
      source,
      /\.style\.display\s*=/,
      `the module owning #${id} must be the one that writes its display`
    );
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
