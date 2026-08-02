import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CSS_ROOT = fileURLToPath(new URL('../assets/css', import.meta.url));

/* Every selector in `assets/css` that is allowed to suppress the shared
   `:focus-visible` ring from `base/_accessibility.css`, with the replacement
   indicator that makes the suppression safe. A selector that removes the
   outline and paints nothing else leaves keyboard focus with no visual
   position at all (WCAG 2.4.7 Focus Visible) — that is CEL-AUDIT-0077, and it
   is why this list is exact rather than a threshold. */
const APPROVED_OUTLINE_SUPPRESSIONS = Object.freeze([
  {
    file: 'base/_accessibility.css',
    selector: ':focus:not(:focus-visible)',
    replacement:
      'None needed: this is the supported opt-out for pointer-initiated focus, '
      + 'and it cannot match a keyboard-focused element.',
  },
  {
    file: 'components/_filters.css',
    selector: '.highlight-page-tab-input',
    replacement:
      'Accent border-bottom on :focus plus the text caret. The inline rename '
      + 'input is removed on blur (highlight-pages-ui.js), so it can never be '
      + 'rendered in an unfocused state.',
  },
]);

async function collectCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectCssFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* Returns `{ file, selector }` for every rule block that declares
   `outline: none` or `outline: 0`, including the outline shorthand. */
function findOutlineSuppressions(relativePath, css) {
  const found = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    const body = match[2];
    if (selector.startsWith('@') || selector.length === 0) continue;
    for (const declaration of body.split(';')) {
      const [property, value] = declaration.split(':');
      if (property === undefined || value === undefined) continue;
      if (property.trim() !== 'outline') continue;
      const normalized = value.trim().replace(/\s*!important$/, '');
      if (normalized === 'none' || normalized === '0') {
        found.push({ file: relativePath, selector });
      }
    }
  }
  return found;
}

const cssFiles = await collectCssFiles(CSS_ROOT);
const suppressions = [];
for (const absolute of cssFiles) {
  const relativePath = path.relative(CSS_ROOT, absolute).split(path.sep).join('/');
  suppressions.push(
    ...findOutlineSuppressions(relativePath, await readFile(absolute, 'utf8')),
  );
}

test('the stylesheet declares exactly one shared focus ring', async () => {
  const css = await readFile(path.join(CSS_ROOT, 'base/_accessibility.css'), 'utf8');
  assert.match(
    css,
    /:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-border-focus\);\s*outline-offset:\s*2px;\s*\}/,
  );
});

test('every outline suppression in the stylesheet is an approved one', () => {
  const approved = new Set(
    APPROVED_OUTLINE_SUPPRESSIONS.map(entry => `${entry.file} :: ${entry.selector}`),
  );
  const actual = suppressions.map(entry => `${entry.file} :: ${entry.selector}`);
  const unapproved = actual.filter(entry => !approved.has(entry));
  assert.deepEqual(
    unapproved,
    [],
    'A selector removes the focus ring without an approved replacement '
    + 'indicator. Paint a replacement, or add it to '
    + 'APPROVED_OUTLINE_SUPPRESSIONS with the indicator that replaces it:\n'
    + unapproved.join('\n'),
  );
  const missing = [...approved].filter(entry => !actual.includes(entry));
  assert.deepEqual(
    missing,
    [],
    'An approved suppression no longer exists; drop it from the list:\n'
    + missing.join('\n'),
  );
});

test('range sliders do not redeclare the outline they must inherit', async () => {
  const css = await readFile(path.join(CSS_ROOT, 'components/_forms.css'), 'utf8');
  const block = css.match(/\.slider-row input\[type="range"\]\s*\{([^}]*)\}/);
  assert.notEqual(block, null, '.slider-row input[type="range"] rule is missing');
  assert.doesNotMatch(
    block[1],
    /outline\s*:/,
    'CEL-AUDIT-0077: the slider must not redeclare outline; the shared '
    + ':focus-visible ring has to reach it.',
  );
});

test('range sliders expose a pointer target the painted thumb fits inside', async () => {
  const css = await readFile(path.join(CSS_ROOT, 'components/_forms.css'), 'utf8');
  const block = css.match(/\.slider-row input\[type="range"\]\s*\{([^}]*)\}/);
  assert.notEqual(block, null, '.slider-row input[type="range"] rule is missing');
  /* WCAG 2.2 SC 2.5.8 Target Size (Minimum) is 24x24 CSS px, and the painted
     thumb is --space-3-5 (14px) tall, so a 3px control box hides part of what
     the user can see. --space-6 is the 24px primitive; the negative block
     margins collapse the margin box back to the 3px track so rows keep their
     density. */
  assert.match(block[1], /height:\s*var\(--space-6\);/);
  assert.match(block[1], /margin-block:\s*calc\(\(3px - var\(--space-6\)\) \/ 2\);/);
  assert.match(
    css,
    /\.slider-row input\[type="range"\]::-webkit-slider-runnable-track\s*\{[^}]*height:\s*3px;/,
  );
  assert.match(
    css,
    /\.slider-row input\[type="range"\]::-moz-range-track\s*\{[^}]*height:\s*3px;/,
  );
});

test('the analysis option slider has no competing definition of its own', async () => {
  const modals = stripComments(
    await readFile(path.join(CSS_ROOT, 'components/_modals.css'), 'utf8'),
  );
  const declaringRules = [...modals.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map(match => match[1].trim().replace(/\s+/g, ' '))
    .filter(selector => selector.startsWith('.analysis-option-range'));
  assert.deepEqual(
    declaringRules,
    [],
    '.analysis-option-range is rendered inside a .slider-row, so a second '
    + 'slider definition here silently diverges from components/_forms.css.',
  );
});
