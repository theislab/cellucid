/**
 * Nested actions are quiet ("Nested actions are quiet" in assets/css/README.md;
 * owner, 2026-11-11: buttons in "a very nested area ... should get more and
 * more muted"). Held at the source:
 *
 * - the modules that draw nested areas (a list item's row or details, a chat
 *   turn, an agent's activity line, an array's row, a suggestion card) build
 *   no pill and no filled button there: every button they make is `quiet` or
 *   `quiet-primary` (or the `danger` confirmation a removal asks for), except
 *   the panel-, dialog- or card-level actions listed by name below — each
 *   with the reason it is not nested, and each still present;
 * - a quiet button is spelled only by the one variant table
 *   (`createButton` / `buttonClassName` in `ui/components/controls.js`);
 * - an action is never a typed character (`⋯`, `✕`, `×`) in those modules,
 *   and an icon button built in code always comes from `createIconButton`
 *   (an `ICONS` glyph), never a hand-set class over a character.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFile(path.join(ROOT, relative), 'utf8');

const QUIET_VARIANTS = new Set(['quiet', 'quiet-primary', 'danger']);

/**
 * The modules of nested areas, and the buttons in them that are not nested
 * (matched on their source line), with why.
 */
const NESTED_MODULES = [
  { file: 'assets/js/app/ui/modules/state/step-details.js', panel: [] },
  { file: 'assets/js/app/ui/modules/state/notes.js', panel: [] },
  { file: 'assets/js/app/ui/modules/state/saved-states-dialog.js', panel: [] },
  { file: 'assets/js/app/ui/modules/state/recently-deleted.js', panel: [] },
  { file: 'assets/js/app/ui/modules/state/memory-dialog.js', panel: [] },
  { file: 'assets/js/app/ui/modules/my-datasets/dialog.js', panel: [] },
  { file: 'assets/js/app/ui/modules/kept-stores-dialog.js', panel: [] },
  { file: 'assets/js/app/ui/modules/field-selector-deleted-fields.js', panel: [] },
  { file: 'assets/js/app/agent/connect/connections-dialog.js', panel: [] },
  { file: 'assets/js/app/agent/chat/transcript-view.js', panel: [] },
  {
    file: 'assets/js/app/agent/presence/index.js',
    panel: [
      // The question card an agent asks (Allow / Deny) is a card of its own over the page.
      { match: /node\.className = `btn btn-compact \$\{className\}`/, why: 'the permission card\'s answers' },
      { match: /agent-notice-done/, why: 'the data notice card\'s one action' },
    ],
  },
  {
    file: 'assets/js/app/ui/modules/data-mapping/dom.js',
    panel: [
      { match: /label: 'Revert'/, why: 'the Data mapping section\'s own footer' },
      { match: /label: 'Apply'/, why: 'the Data mapping section\'s own footer' },
    ],
  },
  {
    file: 'assets/js/app/ui/modules/legend/categorical-legend.js',
    panel: [
      { match: /label: 'Show all'/, why: 'the legend\'s own actions, above its rows' },
      { match: /label: 'Hide all'/, why: 'the legend\'s own actions, above its rows' },
    ],
  },
  {
    file: 'assets/js/app/ui/modules/community-annotation-voting-modal.js',
    panel: [
      { match: /cap-search-close/, why: 'the CAP search panel\'s Close' },
      { match: /community-annotation-modal-close/, why: 'a modal\'s Close' },
      { match: /text: 'Previous'|text: 'Next'/, why: 'a modal\'s paging' },
      { match: /text: 'Previous suggestions'|text: 'Next suggestions'/, why: 'the suggestion list\'s paging' },
      { match: /community-annotation-vote-btn/, why: 'the vote toggles: the card\'s state, pressed is filled' },
      { match: /cap-btn/, why: 'the new-suggestion form\'s CAP tools' },
      { match: /text: 'Add'|text: 'Clear'/, why: 'the new-suggestion form\'s own actions' },
    ],
  },
];

/** The end index of the balanced `{...}` or `(...)` that opens at `start`. */
function closingIndex(source, start) {
  const open = source[start];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === open) depth++;
    else if (source[index] === close && --depth === 0) return index;
  }
  throw new Error(`Unbalanced ${open} at ${start}`);
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;
const lineText = (source, index) => source.split('\n')[lineOf(source, index) - 1].trim();

/** The object literal around `index` (a `className:` property's element options), on one line. */
function enclosingObject(source, index) {
  let depth = 0;
  for (let start = index; start >= 0; start--) {
    if (source[start] === '}') depth++;
    else if (source[start] === '{' && depth-- === 0) {
      return source.slice(start, closingIndex(source, start) + 1).replace(/\s+/g, ' ');
    }
  }
  return lineText(source, index);
}

/** Whether `index` sits in a comment line (a doc comment naming a class is not a button). */
const inComment = (source, index) => /^(\/\/|\*|\/\*)/.test(lineText(source, index));

/**
 * The variants an expression can take: its string literals, or, for a bare
 * identifier, the default its function declares (`variant = 'quiet'`).
 */
function variantsOf(expression, source) {
  const literals = [...expression.matchAll(/'([^']+)'/g)].map(match => match[1]);
  if (literals.length > 0) return literals;
  const name = expression.trim();
  const declared = source.match(new RegExp(`\\b${name} = '([^']+)'`));
  return declared === null ? [`<${name}>`] : [declared[1]];
}

/** Every button a module builds: by `createButton`, by `buttonClassName`, or by a class string with `btn`. */
function buttonSites(source) {
  const sites = [];
  for (const match of source.matchAll(/\bcreateButton\(\{/g)) {
    const open = match.index + match[0].length - 1;
    const body = source.slice(open, closingIndex(source, open) + 1);
    const variant = body.match(/\bvariant(?:\s*:\s*([^,}\n]+))?\s*[,}\n]/);
    const variants = variant === null ? ['secondary'] : variantsOf(variant[1] ?? 'variant', source);
    sites.push({ line: lineOf(source, match.index), text: body.replace(/\s+/g, ' '), variants });
  }
  for (const match of source.matchAll(/\bbuttonClassName\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = source.slice(open + 1, closingIndex(source, open));
    const first = args.split(',')[0];
    sites.push({ line: lineOf(source, match.index), text: lineText(source, match.index), variants: variantsOf(first, source) });
  }
  const classStrings = /(?:className\s*[:=]\s*|class=")(['"`]?)([^'"`]*)/g;
  for (const match of source.matchAll(classStrings)) {
    const tokens = match[2].split(/\s+/);
    if (!tokens.includes('btn') || inComment(source, match.index)) continue;
    sites.push({
      line: lineOf(source, match.index),
      text: /^className\s*:/.test(match[0]) ? enclosingObject(source, match.index) : lineText(source, match.index),
      variants: tokens.includes('btn-danger') ? ['danger'] : ['hand-built'],
    });
  }
  for (const match of source.matchAll(/classList\.add\('btn'/g)) {
    sites.push({ line: lineOf(source, match.index), text: lineText(source, match.index), variants: ['hand-built'] });
  }
  return sites;
}

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
  return out;
}

test('the modules of nested areas build only quiet buttons, apart from the listed panel-level ones', async () => {
  for (const { file, panel } of NESTED_MODULES) {
    const source = await read(file);
    const sites = buttonSites(source);
    assert.ok(sites.length > 0, `${file} builds no button: drop it from the list`);
    const used = new Set();
    for (const site of sites) {
      if (site.variants.every(variant => QUIET_VARIANTS.has(variant))) continue;
      const allowed = panel.findIndex(entry => entry.match.test(site.text));
      assert.notEqual(
        allowed,
        -1,
        `${file}:${site.line} builds a ${site.variants.join('/')} button in a nested area; `
          + `nested actions are quiet (createButton({variant: 'quiet'}) or 'quiet-primary'): ${site.text.slice(0, 160)}`
      );
      used.add(allowed);
    }
    panel.forEach((entry, index) => {
      assert.ok(used.has(index), `${file}: the panel-level entry ${entry.match} (${entry.why}) matches no button any more`);
    });
  }
});

test('a quiet button is spelled only by the one variant table', async () => {
  const files = (await listFiles('assets/js', '.js'))
    .filter(file => file !== 'assets/js/app/ui/components/controls.js');
  const offenders = [];
  for (const file of files) {
    const source = await read(file);
    for (const match of source.matchAll(/['"`][^'"`\n]*\bbtn-quiet\b[^'"`\n]*['"`]/g)) {
      if (inComment(source, match.index)) continue;
      offenders.push(`${file}:${lineOf(source, match.index)} ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'use createButton({variant}) or buttonClassName(variant)');
});

test('nested areas name their actions in words or with an ICONS glyph, never a typed character', async () => {
  const glyph = /(?:textContent\s*=\s*|text:\s*|label:\s*)'(?:⋯|…|✕|×|\.\.\.)'/g;
  for (const { file } of NESTED_MODULES) {
    const source = await read(file);
    const found = [...source.matchAll(glyph)].map(match => `${file}:${lineOf(source, match.index)} ${match[0]}`);
    assert.deepEqual(found, [], `${file}: a typed character as an action ("More…", "Remove", or createIconButton with ICONS)`);
  }
  // An icon button built in code comes from createIconButton, which draws an
  // ICONS glyph; a hand-set `icon-btn` class is where a typed character crept in.
  const files = (await listFiles('assets/js', '.js'))
    .filter(file => file !== 'assets/js/app/ui/components/controls.js');
  const typed = [];
  for (const file of files) {
    const source = await read(file);
    for (const match of source.matchAll(/className\s*=\s*['"`][^'"`]*\bicon-btn\b/g)) {
      typed.push(`${file}:${lineOf(source, match.index)}`);
    }
  }
  assert.deepEqual(typed, [], 'an icon button draws an ICONS glyph: createIconButton({label, icon: ICONS.…})');
});

/**
 * A button never borrows a text link's look (F102, coordinator's decision of
 * the owner's consistency rule): the analysis windows' `.analysis-link-btn`
 * and Community annotation's underlined comment Edit/Delete, View merged,
 * View full evidence and View all comments were a second quiet look beside
 * `.btn-quiet` — tertiary text faded to 75% (below AA contrast) and no
 * target size. Every underline the stylesheet draws, other than on hover or
 * focus, is listed here with the link it marks; a new one fails until it is
 * listed or drawn as `.btn-quiet`.
 */
const UNDERLINED = Object.freeze({
  'components/_buttons.css :: .info-tip-link': 'a link (`a`) in an (i) tip',
  'components/_controls.css :: .gene-read-link': 'the gene sample line, a link to Genes read for inside a status line',
  'components/_controls.css :: .fact-list > dd[title]': 'a fact whose whole text is its title (dotted cue, not an action)',
  'components/_modals.css :: .app-dialog-body a': 'links (`a`) in a dialog\'s prose',
  'components/_session.css :: .connection-help': 'the sign-in help link (`a`)',
  'components/_state.css :: .history-tip-settings-link': 'History settings…, a link inside a sentence of the History tip',
  'components/_welcome.css :: .welcome-links a': 'the welcome card\'s links (`a`)',
  'layouts/_page.css :: .page-prose a:not(.welcome-links a)': 'links (`a`) in a standalone page\'s prose',
});

test('no button is drawn as an underlined text link, apart from the listed links in running text', async () => {
  const found = [];
  for (const file of await listFiles('assets/css', '.css')) {
    const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/text-decoration(?:-line)?\s*:\s*underline/.test(match[2])) continue;
      for (const selector of match[1].split(',').map(part => part.trim().replace(/\s+/g, ' '))) {
        if (/:hover|:focus/.test(selector)) continue;
        found.push(`${file.replace('assets/css/', '')} :: ${selector}`);
      }
    }
  }
  assert.deepEqual(found.sort(), Object.keys(UNDERLINED).sort(), 'an action nested in a card or a window is .btn-quiet (buttonClassName("quiet")), not an underlined link');
  const gone = [];
  for (const file of await listFiles('assets/js', '.js')) {
    const source = await read(file);
    for (const name of ['analysis-link-btn', 'community-annotation-comment-action-btn', 'community-annotation-merged-comment-btn']) {
      if (source.includes(name)) gone.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(gone, [], 'the link-look button classes are gone');
});

/**
 * A chip's removal (and a page's combine) glyph is quiet by the secondary text
 * color (a quiet button's), never by opacity: the kept view's × faded to 50% read at 3.22:1
 * (lens-a11y LF-10), and the highlight pages' ⋈ and × and the gene chips' ×
 * were faded the same way. Opacity stacks on whatever color the chip has; a
 * text token is held to AA by `theme-contrast-contract`.
 */
test('a removal glyph is quiet by color, not faded', async () => {
  const faded = [];
  for (const file of await listFiles('assets/css', '.css')) {
    const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/-(?:remove|delete|combine)\b/.test(match[1])) continue;
      if (/(?:^|;)\s*opacity\s*:\s*(?!1\b|var\(--opacity-100\)|var\(--control-disabled-opacity\))/.test(match[2])) {
        faded.push(`${file}: ${match[1].trim().replace(/\s+/g, ' ')}`);
      }
    }
  }
  assert.deepEqual(faded, []);
});
