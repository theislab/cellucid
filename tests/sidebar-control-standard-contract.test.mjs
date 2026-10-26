/**
 * The sidebar control standard ("Sidebar Control Standard" in
 * assets/css/README.md), held at the source so it cannot drift back:
 *
 * - every field label is a `<label for>` (or wraps its one checkbox) and no
 *   label or heading ends in a colon;
 * - state is ARIA and `hidden`: no inline `display` writes and no inline
 *   `style` in markup, outside a short list of geometry owners;
 * - every number the interface prints goes through display-format.js;
 * - the replaced classes are gone from markup, code and CSS;
 * - component CSS names colours through tokens and does not fight the
 *   cascade with `!important` outside the listed third-party overrides.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFile(path.join(ROOT, relative), 'utf8');

async function listFiles(relativeDir, extension) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith(extension)) out.push(relative);
    }
  }
  await walk(relativeDir);
  return out.sort();
}

const indexHtml = (await read('index.html')).replace(/<!--[\s\S]*?-->/g, '');
const cssReadme = await read('assets/css/README.md');

/** Sidebar and selection-bar markup. */
function sidebarMarkup() {
  const start = indexHtml.indexOf('<section id="select-bar"');
  const end = indexHtml.indexOf('<div id="stats"');
  assert.ok(start > 0 && end > start, 'the sidebar markup must be found');
  return indexHtml.slice(start, end);
}
const SIDEBAR = sidebarMarkup();
const DOCUMENT_IDS = new Set(
  Array.from(indexHtml.matchAll(/\sid="([^"]+)"/g), match => match[1])
);

const UI_JS_DIRS = ['assets/js/app/ui', 'assets/js/app/analysis/ui'];
const UI_JS_FILES = [
  ...(await Promise.all(UI_JS_DIRS.map(dir => listFiles(dir, '.js')))).flat(),
  'assets/js/app/analysis/comparison-module.js'
];
const UI_JS = new Map(
  await Promise.all(UI_JS_FILES.map(async file => [file, await read(file)]))
);
const CSS_FILES = [
  ...(await listFiles('assets/css/components', '.css')),
  ...(await listFiles('assets/css/layouts', '.css'))
];
const CSS = new Map(
  await Promise.all(CSS_FILES.map(async file => [
    file,
    (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '')
  ]))
);

test('the rules held here are the ones the design system states', () => {
  for (const phrase of [
    '## Sidebar Control Standard',
    'never end in a colon',
    'Visibility is the `hidden` attribute',
    'display-format.js',
    'coalesceToFrame'
  ]) {
    assert.ok(cssReadme.includes(phrase), `README must state: ${phrase}`);
  }
});

test('every sidebar label names exactly one control', () => {
  const offenders = [];
  for (const match of SIDEBAR.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
    const [, attributes, body] = match;
    const target = attributes.match(/\bfor="([^"]+)"/)?.[1];
    const wrapped = (body.match(/<input\b/g) ?? []).length;
    if (target !== undefined) {
      if (!DOCUMENT_IDS.has(target)) offenders.push(`for="${target}" names no element`);
      continue;
    }
    if (!/\bclass="[^"]*\bcheckbox-inline\b/.test(attributes) || wrapped !== 1) {
      offenders.push(`<label${attributes}>${body.trim().slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no label or heading ends in a colon', () => {
  const offenders = [];
  const visibleText = /<(label|h3)\b[^>]*>([^<]*?):\s*<\/\1>/g;
  for (const [, , text] of SIDEBAR.matchAll(visibleText)) offenders.push(`index.html: ${text}:`);
  for (const [file, source] of UI_JS) {
    for (const [, text] of source.matchAll(/<(?:label|h3)\b[^>]*>([^<$]*?):<\/(?:label|h3)>/g)) {
      offenders.push(`${file}: ${text}:`);
    }
    for (const [, text] of source.matchAll(/\b(?:label|title|labelText):\s*['"`]([^'"`\n]*?):['"`]/g)) {
      offenders.push(`${file}: ${text}:`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every sidebar button states its type and every disclosure owns its region', () => {
  const untyped = Array.from(SIDEBAR.matchAll(/<button\b([^>]*)>/g))
    .filter(([, attributes]) => !/\btype="(button|submit)"/.test(attributes))
    .map(([tag]) => tag);
  assert.deepEqual(untyped, []);

  for (const [tag] of SIDEBAR.matchAll(/<button\b[^>]*class="disclosure-header"[^>]*>/g)) {
    const expanded = tag.match(/aria-expanded="(true|false)"/)?.[1];
    const controls = tag.match(/aria-controls="([^"]+)"/)?.[1];
    assert.ok(expanded && controls, `${tag} must carry aria-expanded and aria-controls`);
    const region = SIDEBAR.match(new RegExp(`<[^>]*\\sid="${controls}"[^>]*>`))?.[0];
    assert.ok(region, `${controls} must exist`);
    assert.equal(/\shidden(?=[\s>])/.test(region), expanded === 'false', `${controls} hidden state`);
  }
  for (const [tag] of SIDEBAR.matchAll(/<button\b[^>]*role="switch"[^>]*>/g)) {
    assert.match(tag, /aria-checked="(true|false)"/);
  }
  for (const [tag] of SIDEBAR.matchAll(/<button\b[^>]*class="segmented-btn"[^>]*>/g)) {
    assert.match(tag, /aria-pressed="(true|false)"/);
  }
});

test('state is ARIA and hidden, never inline display', () => {
  assert.doesNotMatch(SIDEBAR, /\sstyle="/, 'sidebar markup carries no inline style');

  // The one remaining owner: the points/smoke render-mode switch, which is
  // the smoke controls' own code and out of this standard's reach.
  const ALLOWED_DISPLAY_WRITES = new Map([
    ['assets/js/app/ui/modules/render-controls.js', 2]
  ]);
  // Share writes an embed snippet *for the user to paste into their own
  // page*; its `style="border: 0;"` is text in a textarea, never markup this
  // interface renders.
  const ALLOWED_STYLE_TEXT = new Set([
    'assets/js/app/ui/modules/share-dialog.js'
  ]);
  const offenders = [];
  for (const [file, source] of UI_JS) {
    const writes = (source.match(/\.style\.display\s*=/g) ?? []).length;
    if (writes !== (ALLOWED_DISPLAY_WRITES.get(file) ?? 0)) {
      offenders.push(`${file}: ${writes} inline display writes`);
    }
    if (/\.style\.cssText\s*=|setAttribute\(\s*['"]style['"]/.test(source)) {
      offenders.push(`${file}: inline style text`);
    }
    if (/\sstyle=\\?["']/.test(source) && !ALLOWED_STYLE_TEXT.has(file)) {
      offenders.push(`${file}: inline style text`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every interface number goes through the shared formatter', () => {
  const offenders = [];
  for (const [file, source] of UI_JS) {
    if (/\.toLocaleString\(/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'use ui/components/display-format.js');
  // Multipliers are drawn with the multiplication sign, never the letter x.
  assert.doesNotMatch(SIDEBAR, /class="slider-value">[0-9.]+x</);
});

test('the replaced control classes are gone from markup, code and CSS', () => {
  const RETIRED = [
    'reset-btn', 'btn-small', 'toggle-switch', 'field-action-btn',
    'field-delete-btn', 'legend-rename-btn-legacy', 'cinematic-kf-btn',
    'highlight-clear-btn', 'legend-help', 'filter-info',
    'filter-info-block', 'filter-item', 'highlight-item', 'filter-remove-btn',
    'highlight-remove-btn', 'nav-mode-box', 'display-options-box',
    'cinematic-settings-box', 'cinematic-empty-state', 'select-mode-switch',
    'select-combine-btn', 'select-combine-segments', 'search-input',
    'user-data-path', 'figure-input', 'form-checkbox-row',
    'analysis-accordion', 'analysis-accordion-item', 'analysis-accordion-header',
    'confirm-dialog-btn', 'cat-builder-btn', 'bottleneck-spinner',
    'dropdown-visible', 'legend-section-title', 'legend-toggle-label'
  ];
  const sources = [
    ['index.html', indexHtml],
    ...UI_JS,
    ...CSS
  ];
  const offenders = [];
  for (const name of RETIRED) {
    const pattern = new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
    for (const [file, source] of sources) {
      if (pattern.test(source)) offenders.push(`${name} in ${file}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('component CSS names colours through tokens', () => {
  const offenders = [];
  for (const [file, source] of CSS) {
    for (const [declaration] of source.matchAll(/[a-z-]+\s*:[^;{}]*;/g)) {
      if (/#[0-9a-f]{3,8}\b/i.test(declaration)) offenders.push(`${file}: ${declaration}`);
      if (/\b(?:rgba?|hsla?)\((?!var\(--shadow-rgb\))/.test(declaration)) {
        offenders.push(`${file}: ${declaration}`);
      }
      if (/(?<![\w-])(?:white|black|red|green|blue|gray|grey|yellow|orange|purple)(?![\w-])/.test(declaration)) {
        offenders.push(`${file}: ${declaration}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('!important appears only where it overrides a third party or an inline owner', () => {
  // Plotly injects unlayered styles that outrank every layered rule; the
  // canvas cursor and the notification progress width are written inline by
  // their owners; a drag in progress must win over every transition; the
  // full-screen expanded view on a narrow screen overrides the sizes its
  // resize writes inline (kept for a wider screen).
  const ALLOWED = new Map([
    ['assets/css/components/_analysis.css', /\.modebar|plot/],
    ['assets/css/components/_modals.css', /^\s*\.analysis-modal-(?:content|options|stats-panel)\b/],
    ['assets/css/components/_notifications.css', /indeterminate/],
    ['assets/css/components/_filters.css', /#glcanvas/],
    ['assets/css/components/_accordion.css', /dock-dragging|dock-resizing|\.dragging|\.resizing/],
    ['assets/css/layouts/_print.css', /./]
  ]);
  const offenders = [];
  for (const [file, source] of CSS) {
    for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!body.includes('!important')) continue;
      const allowed = ALLOWED.get(file);
      if (allowed === undefined || !allowed.test(selector)) {
        offenders.push(`${file}: ${selector.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('focus is the shared :focus-visible ring, never a mouse-focus outline', () => {
  const offenders = [];
  for (const [file, source] of CSS) {
    for (const [, selector] of source.matchAll(/([^{}]+)\{[^{}]*outline[^{}]*\}/g)) {
      if (/:focus(?![-\w])/.test(selector)) offenders.push(`${file}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
