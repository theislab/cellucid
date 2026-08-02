/**
 * The published `default.cellucid-session` presets record the *complete* UI
 * control inventory, so adding one identified input to the sidebar invalidates
 * every preset that was saved before it existed (CEL-0224). The loader refuses
 * the whole document with `Session UI state is missing current control
 * "<id>"`, and the visible result is that the advertised camera never applies
 * and no field is coloured. Removing a control is equally fatal in the other
 * direction: the preset then carries a key the interface no longer has, and the
 * loader refuses with `... does not exist in the current interface`.
 *
 * Nothing guarded this. The advertised-default browser spec builds its session
 * bundle at runtime from the page it just loaded, so its bundle and its markup
 * can never disagree — it cannot see a stale *checked-in* file. The failure
 * only surfaced when someone opened a sample.
 *
 * ## What this file compares
 *
 * The current control inventory is derived from `index.html` by running the
 * application's own `collectUIControls()` against a parsed copy of that
 * markup. Nothing here restates which controls are serialized. The three
 * filters that define the inventory — `data-state-serializer-skip` ancestors,
 * `DOMAIN_OWNED_IDS`, and `SERIALIZABLE_INPUT_TYPES` — all live in
 * `assets/js/app/state-serializer/ui-controls.js` and are applied by that
 * module here exactly as they are in the browser. A fourth *filter* added there
 * is honoured by this file the day it lands, with no edit. That is the whole
 * point: a restated list would be the same defect one level up.
 *
 * A new *selector* is the one thing that does need an edit here, and
 * deliberately so: the parsed-markup shim below throws on a query it does not
 * implement rather than returning an empty list, because an unimplemented
 * selector answered with `[]` would silently shrink the inventory and make
 * every stale preset look current. `[data-state-serializer-pressed-group]` and
 * `button[id]` were added to the shim when the highlight toolbelt joined the
 * inventory (CEL-0249).
 *
 * The comparison is the **inventory**: the set of keys and the control type
 * each key declares. Both are decided by the markup alone, and both are what
 * CEL-0224 broke.
 *
 * The inventory is read out of `index.html`, which is where every serialized
 * control lives today: the modules that build panels bind to markup that is
 * already there, and the ones that create their own controls mark the subtree
 * `data-state-serializer-skip`. `#floating-panels-root` *moves* accordion
 * sections rather than creating them, so floating a panel does not change the
 * union either. A module that one day creates a serialized control inside the
 * sidebar without a skip marker would be invisible here and would read as a
 * preset carrying a key the markup lacks — so the failure below names that
 * cause alongside the ordinary one.
 *
 * The comparison deliberately stops short of control *values*. A value is not
 * statically decidable: `#velocity-field` ships with no options at all and is
 * populated from the loaded dataset, and a colour input with no `value`
 * attribute reports a value the browser supplies rather than the markup. A
 * guard that judged values from static markup would fail on correct presets,
 * which is the failure mode that would make it worse than nothing. Values are
 * covered where they can be: by the browser specs, against a live page.
 *
 * ## Recovering when this fails
 *
 * The presets are not regenerated from markup — they are real saves. When a
 * control is added or removed, each published preset has to be re-saved and
 * repinned in `cellucid-datasets`:
 *
 *  1. open the app on the dataset, restore its current preset, and save state;
 *  2. write the result to `exports/<id>/default.cellucid-session`;
 *  3. repin `state_sha256` for that entry in `exports/datasets.json`;
 *  4. repin the same digest and the stored byte counts in
 *     `tests/catalog-contract.test.mjs` and
 *     `tests/session-presets-contract.test.mjs`.
 *
 * All five presets carry the same inventory, so a control change always
 * invalidates all five, never one.
 */

import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';

const INDEX_URL = new URL('../index.html', import.meta.url);
const PRESET_REPOSITORY_URL = new URL('../../cellucid-datasets/', import.meta.url);
const PRESET_EXPORTS_URL = new URL('exports/', PRESET_REPOSITORY_URL);
const PRESET_FILENAME = 'default.cellucid-session';

const indexHtml = await readFile(INDEX_URL, 'utf8');

/* ------------------------------------------------------------------ *
 * A DOM just large enough for the queries `ui-controls.js` issues.
 *
 * `buildCurrentInventory()` uses exactly three selectors, `closest()` with one
 * attribute selector, and a handful of property reads. Anything else throws
 * rather than returning a plausible wrong answer, so a future query cannot be
 * silently mis-served by this shim.
 *
 * The tree walk is checked against an independent scan of the same file in
 * `the parsed markup accounts for every control element in the file` below; a
 * walk that lost a subtree would otherwise read as "no controls were added".
 * ------------------------------------------------------------------ */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * The HTML input types a browser keeps. `input.type` reports `text` for
 * anything else, which is what makes an unknown type indistinguishable from a
 * text box. This is the HTML specification's list, not a Cellucid policy, and
 * it decides nothing about what is serialized.
 */
const HTML_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file',
  'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset',
  'search', 'submit', 'tel', 'text', 'time', 'url', 'week',
]);

class ParsedElement {
  constructor(tagName, attributes, parentElement) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.parentElement = parentElement;
    this.children = [];
    this.rawText = '';
  }

  get id() {
    return this.attributes.id ?? '';
  }

  get classNames() {
    return (this.attributes.class ?? '').split(/\s+/).filter(Boolean);
  }

  get type() {
    if (this.tagName !== 'input') return this.attributes.type ?? '';
    const declared = (this.attributes.type ?? '').toLowerCase();
    return HTML_INPUT_TYPES.has(declared) ? declared : 'text';
  }

  get checked() {
    return Object.hasOwn(this.attributes, 'checked');
  }

  get open() {
    return Object.hasOwn(this.attributes, 'open');
  }

  get min() {
    return this.attributes.min ?? '';
  }

  get max() {
    return this.attributes.max ?? '';
  }

  get options() {
    return this.descendants().filter(node => node.tagName === 'option');
  }

  get value() {
    if (this.tagName === 'option') {
      return this.attributes.value ?? this.rawText.trim();
    }
    if (this.tagName === 'select') {
      const { options } = this;
      const selected = options.find(
        option => Object.hasOwn(option.attributes, 'selected'),
      );
      if (selected !== undefined) return selected.value;
      return options.length > 0 ? options[0].value : '';
    }
    return this.attributes.value ?? '';
  }

  descendants(collected = []) {
    for (const child of this.children) {
      collected.push(child);
      child.descendants(collected);
    }
    return collected;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  closest(selector) {
    const attributeSelector = /^\[([a-z][a-z-]*)\]$/.exec(selector);
    if (attributeSelector === null) {
      throw new Error(
        `The parsed-markup shim implements closest() only for a single `
          + `attribute selector; received ${JSON.stringify(selector)}.`,
      );
    }
    for (let node = this; node !== null; node = node.parentElement) {
      if (Object.hasOwn(node.attributes, attributeSelector[1])) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const all = this.descendants();
    if (selector === 'input[id]') {
      return all.filter(node => node.tagName === 'input' && node.id.length > 0);
    }
    if (selector === 'select[id]') {
      return all.filter(node => node.tagName === 'select' && node.id.length > 0);
    }
    if (selector === 'details.accordion-section') {
      return all.filter(
        node => node.tagName === 'details'
          && node.classNames.includes('accordion-section'),
      );
    }
    if (selector === 'button[id]') {
      return all.filter(node => node.tagName === 'button' && node.id.length > 0);
    }
    const attributeSelector = /^\[([a-z][a-z-]*)\]$/.exec(selector);
    if (attributeSelector !== null) {
      return all.filter(
        node => Object.hasOwn(node.attributes, attributeSelector[1]),
      );
    }
    throw new Error(
      `The parsed-markup shim implements querySelectorAll() only for the `
        + `selectors ui-controls.js issues; received ${JSON.stringify(selector)}.`,
    );
  }
}

/** Index of the `>` that closes the tag opening at `openIndex`. */
function findTagEnd(html, openIndex) {
  let quote = null;
  for (let cursor = openIndex + 1; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor;
    }
  }
  return -1;
}

function parseAttributes(source) {
  const attributes = {};
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (Object.hasOwn(attributes, name)) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function parseHtml(html) {
  const documentRoot = new ParsedElement('#document', {}, null);
  let openElement = documentRoot;
  let cursor = 0;

  while (cursor < html.length) {
    const openIndex = html.indexOf('<', cursor);
    if (openIndex === -1) {
      openElement.rawText += html.slice(cursor);
      break;
    }
    openElement.rawText += html.slice(cursor, openIndex);

    if (html.startsWith('<!--', openIndex)) {
      const commentEnd = html.indexOf('-->', openIndex);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html.startsWith('<!', openIndex) || html.startsWith('<?', openIndex)) {
      const declarationEnd = html.indexOf('>', openIndex);
      cursor = declarationEnd === -1 ? html.length : declarationEnd + 1;
      continue;
    }
    if (html.startsWith('</', openIndex)) {
      const closeEnd = html.indexOf('>', openIndex);
      const name = html.slice(openIndex + 2, closeEnd).trim().toLowerCase();
      let target = openElement;
      while (target !== documentRoot && target.tagName !== name) {
        target = target.parentElement;
      }
      if (target !== documentRoot) openElement = target.parentElement;
      cursor = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, openIndex);
    if (tagEnd === -1) {
      openElement.rawText += html.slice(openIndex);
      break;
    }
    const tagSource = html.slice(openIndex + 1, tagEnd);
    const nameMatch = /^([a-zA-Z][-a-zA-Z0-9:]*)/.exec(tagSource);
    if (nameMatch === null) {
      cursor = tagEnd + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const selfClosing = tagSource.trimEnd().endsWith('/');
    const element = new ParsedElement(
      name,
      parseAttributes(tagSource.slice(nameMatch[0].length).replace(/\/$/, '')),
      openElement,
    );
    openElement.children.push(element);
    cursor = tagEnd + 1;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeIndex = html.toLowerCase().indexOf(`</${name}`, cursor);
      element.rawText = closeIndex === -1
        ? html.slice(cursor)
        : html.slice(cursor, closeIndex);
      cursor = closeIndex === -1 ? html.length : html.indexOf('>', closeIndex) + 1;
      continue;
    }
    if (!VOID_ELEMENTS.has(name) && !selfClosing) openElement = element;
  }

  return documentRoot;
}

function findById(root, id) {
  return root.descendants().find(node => node.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * Deriving the inventory with the application's own collector.
 * ------------------------------------------------------------------ */

/**
 * `getUiRoots()` reads `#floating-panels-root` off the global document.
 *
 * That root does not exist in `index.html`: `app/dockable-accordions.js`
 * creates it on demand and *moves* accordion sections into it, so floating a
 * panel relocates a control without adding or removing one. The static union is
 * therefore exactly the sidebar subtree, and reporting the root as absent is
 * faithful to the markup rather than a simplification of it.
 */
function withParsedDocument(documentRoot, run) {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (id === 'floating-panels-root') return null;
      return findById(documentRoot, id);
    },
  };
  try {
    return run();
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
}

/**
 * The control inventory the given markup would produce, as the application
 * itself computes it.
 *
 * @param {string} html
 * @returns {{
 *   documentRoot: ParsedElement,
 *   sidebar: ParsedElement,
 *   controls: Record<string, { type: string }>,
 * }}
 */
function deriveInventory(html) {
  const documentRoot = parseHtml(html);
  const sidebar = findById(documentRoot, 'sidebar');
  assert.ok(
    sidebar !== null,
    'index.html must carry #sidebar: it is the root the session serializer is '
      + 'handed, and without it this file would compare an empty inventory '
      + 'against every preset and pass',
  );
  const controls = withParsedDocument(
    documentRoot,
    () => createUiControlSerializer({ sidebar }).collectUIControls(),
  );
  return { documentRoot, sidebar, controls };
}

const currentMarkup = deriveInventory(indexHtml);
const currentInventory = currentMarkup.controls;
const currentInventoryKeys = Object.keys(currentInventory).sort();

/**
 * The refusal the loader raises for this candidate against this markup.
 *
 * `validateCompleteControls()` compares the two key sets in full before it
 * inspects a single record, so a candidate whose keys disagree always fails on
 * the key comparison. That is the only situation this is called in, which is
 * what keeps the statically undecidable value checks out of reach.
 */
function loaderRefusalFor(markup, candidateControls) {
  try {
    withParsedDocument(
      markup.documentRoot,
      () => createUiControlSerializer({ sidebar: markup.sidebar })
        .validateUIControls(candidateControls),
    );
  } catch (error) {
    return error.message;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Reading the published presets out of the sibling repository.
 * ------------------------------------------------------------------ */

const SESSION_MAGIC = 'CELLUCID_SESSION\n';

function decodeCoreStateControls(bytes, label) {
  const magicLength = Buffer.byteLength(SESSION_MAGIC);
  assert.equal(
    bytes.subarray(0, magicLength).toString('utf8'),
    SESSION_MAGIC,
    `${label} must open with the session container magic`,
  );
  let offset = magicLength;
  const manifestLength = bytes.readUInt32LE(offset);
  offset += 4;
  const manifest = JSON.parse(
    bytes.subarray(offset, offset + manifestLength).toString('utf8'),
  );
  offset += manifestLength;

  const payloads = [];
  while (offset < bytes.length) {
    const chunkLength = bytes.readUInt32LE(offset);
    offset += 4;
    payloads.push(bytes.subarray(offset, offset + chunkLength));
    offset += chunkLength;
  }

  const index = manifest.chunks.findIndex(chunk => chunk.id === 'core/state');
  assert.ok(
    index >= 0,
    `${label} must carry a core/state chunk: it is the chunk that holds the `
      + 'recorded control inventory',
  );
  const chunk = manifest.chunks[index];
  assert.equal(chunk.codec, 'gzip', `${label} core/state must be gzip`);
  const coreState = JSON.parse(gunzipSync(payloads[index]).toString('utf8'));
  assert.ok(
    coreState.uiControls !== null && typeof coreState.uiControls === 'object',
    `${label} core/state must carry a uiControls record`,
  );
  return coreState.uiControls;
}

/**
 * The presets, or `null` when the sibling repository is not checked out.
 *
 * Only an absent *repository* is a reason to skip. A repository that is present
 * but publishes no `exports/` is a defect, not an environment, so that case is
 * left to fail.
 */
async function readPublishedPresets() {
  let repositoryRoot;
  try {
    repositoryRoot = await stat(PRESET_REPOSITORY_URL);
  } catch {
    return null;
  }
  if (!repositoryRoot.isDirectory()) return null;

  const entries = await readdir(PRESET_EXPORTS_URL, { withFileTypes: true });
  const presets = [];
  for (const entry of entries.filter(candidate => candidate.isDirectory())) {
    const presetUrl = new URL(
      `${entry.name}/${PRESET_FILENAME}`,
      PRESET_EXPORTS_URL,
    );
    let bytes;
    try {
      bytes = await readFile(presetUrl);
    } catch {
      continue;
    }
    const label = `${entry.name}/${PRESET_FILENAME}`;
    presets.push({
      datasetId: entry.name,
      label,
      controls: decodeCoreStateControls(bytes, label),
    });
  }
  return presets.sort((left, right) =>
    left.datasetId.localeCompare(right.datasetId));
}

/* ------------------------------------------------------------------ *
 * Markup edits used to prove the guard discriminates.
 *
 * Every edit is applied to the real `index.html` text and re-parsed, so the
 * same derivation runs on it that runs on the shipped file.
 * ------------------------------------------------------------------ */

function tagRange(html, id) {
  const marker = `id="${id}"`;
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `index.html must carry ${marker}`);
  assert.equal(
    html.indexOf(marker, at + 1),
    -1,
    `${marker} must appear once, or these edits would target an ambiguous tag`,
  );
  const start = html.lastIndexOf('<', at);
  const end = findTagEnd(html, start);
  assert.ok(start >= 0 && end > start, `${marker} must sit inside one tag`);
  return { start, end: end + 1 };
}

function insertAfterTagOf(html, anchorId, snippet) {
  const { end } = tagRange(html, anchorId);
  return `${html.slice(0, end)}\n${snippet}${html.slice(end)}`;
}

function tagTextOf(html, id) {
  const { start, end } = tagRange(html, id);
  return html.slice(start, end);
}

function removeTagOf(html, id) {
  const { start, end } = tagRange(html, id);
  return html.slice(0, start) + html.slice(end);
}

function insertInsideFirstSkippedBlock(html, snippet) {
  const marker = html.indexOf('data-state-serializer-skip');
  assert.ok(
    marker >= 0,
    'index.html must carry at least one data-state-serializer-skip subtree',
  );
  const start = html.lastIndexOf('<', marker);
  const end = findTagEnd(html, start);
  assert.ok(end > start, 'the skip-marked element must sit inside one tag');
  return `${html.slice(0, end + 1)}\n${snippet}${html.slice(end + 1)}`;
}

/**
 * An inventoried `<input>` to anchor insertions on and to remove.
 *
 * Derived rather than named, so the edits keep working when the panel is
 * rearranged. A `<select>` would be a poor anchor for removal because deleting
 * its opening tag orphans its options.
 */
const anchorInput = (() => {
  const inventoried = currentMarkup.sidebar
    .querySelectorAll('input[id]')
    .filter(element => Object.hasOwn(currentInventory, element.id));
  assert.ok(
    inventoried.length > 0,
    'the sidebar must inventory at least one input, or these edits have '
      + 'nothing to anchor on',
  );
  return inventoried[0];
})();

const PROBE_ID = 'cel-probe-control';

test('the parsed markup accounts for every control element in the file', () => {
  // The tree walk is the part of this file that could fail open: a lost
  // subtree looks exactly like "nothing was added". This compares it against a
  // scan that shares none of its logic.
  const scanTags = (tagName) => [...indexHtml.matchAll(new RegExp(`<${tagName}\\b`, 'gi'))]
    .map(match => indexHtml.slice(match.index, findTagEnd(indexHtml, match.index) + 1));
  const identifierOf = (tag) => {
    const match = /\bid\s*=\s*"([^"]*)"/.exec(tag);
    return match === null ? '' : match[1];
  };

  for (const tagName of ['input', 'select', 'details']) {
    const accordionsOnly = tagName === 'details';
    const walked = currentMarkup.documentRoot
      .querySelectorAll(accordionsOnly ? 'details.accordion-section' : `${tagName}[id]`)
      .map(element => element.id)
      .filter(id => id.length > 0)
      .sort();
    const scanned = scanTags(tagName)
      .filter(tag => !accordionsOnly
        || (/\bclass\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? '')
          .split(/\s+/)
          .includes('accordion-section'))
      .map(identifierOf)
      .filter(id => id.length > 0)
      .sort();
    assert.deepEqual(
      walked,
      scanned,
      `the parsed <${tagName}> elements must be exactly the ones an `
        + 'independent scan of index.html finds; a difference means the tree '
        + 'walk lost or invented markup and every inventory below is suspect',
    );
  }

  // Pressed-button groups are found by attribute rather than by tag, so the
  // walk is cross-checked the same way: an independent scan for the marker.
  const walkedGroups = currentMarkup.documentRoot
    .querySelectorAll('[data-state-serializer-pressed-group]')
    .map(element => element.id)
    .sort();
  const scannedGroups = scanTags('div')
    .filter(tag => /\bdata-state-serializer-pressed-group\b/.test(tag))
    .map(identifierOf)
    .sort();
  assert.deepEqual(
    walkedGroups,
    scannedGroups,
    'the parsed pressed-button groups must be exactly the ones an independent '
      + 'scan of index.html finds',
  );
  assert.ok(
    walkedGroups.every(id => id.length > 0),
    'every pressed-button group needs a stable id, which is its session key',
  );

  assert.ok(
    currentInventoryKeys.length > 0,
    'the derived inventory must not be empty, or every comparison below is '
      + 'vacuous',
  );
});

test('a pressed-button group added to the markup fails the guard and is named', () => {
  // The toolbelt derivation has to participate in the guard, or a second
  // toolbelt could be added and every preset would silently go stale again.
  const probeGroupId = `${PROBE_ID}-group`;
  const added = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<div id="${probeGroupId}" data-state-serializer-pressed-group>`
      + `<button id="${probeGroupId}-on" aria-pressed="true">On</button>`
      + `<button id="${probeGroupId}-off" aria-pressed="false">Off</button>`
      + '</div>',
  ));

  assert.deepEqual(
    added.controls[probeGroupId],
    { type: 'pressed-group', pressedId: `${probeGroupId}-on` },
    'a marked group must enter the inventory as one control, or this edit '
      + 'proves nothing',
  );
  assert.deepEqual(
    Object.keys(added.controls).filter(
      key => !Object.hasOwn(currentInventory, key),
    ),
    [probeGroupId],
    'exactly the added group must be new',
  );
  assert.equal(
    loaderRefusalFor(added, currentInventory),
    `Session UI state is missing current control "${probeGroupId}".`,
    'the loader must name the toolbelt a preset saved before it existed lacks',
  );

  // The identical markup without the marker is not a control. That is what
  // proves the inclusion above is the marker and not the buttons.
  const unmarked = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<div id="${probeGroupId}">`
      + `<button id="${probeGroupId}-on" aria-pressed="true">On</button>`
      + '</div>',
  ));
  assert.deepEqual(
    Object.keys(unmarked.controls).sort(),
    currentInventoryKeys,
    'an unmarked button group is not serialized, so the field-action toolbars '
      + 'and every other button in the sidebar stay out of the inventory',
  );
});

test('every published preset records the current control inventory', async (t) => {
  const presets = await readPublishedPresets();
  if (presets === null) {
    t.skip(
      'the cellucid-datasets repository is not checked out beside this one, '
        + 'so the published presets cannot be read here',
    );
    return;
  }
  assert.ok(
    presets.length > 0,
    `${PRESET_EXPORTS_URL.pathname} exists but publishes no `
      + `${PRESET_FILENAME}; an empty exports tree must not read as agreement`,
  );

  for (const preset of presets) {
    const presetKeys = Object.keys(preset.controls).sort();
    const missingFromPreset = currentInventoryKeys.filter(
      key => !Object.hasOwn(preset.controls, key),
    );
    const absentFromMarkup = presetKeys.filter(
      key => !Object.hasOwn(currentInventory, key),
    );

    if (missingFromPreset.length > 0 || absentFromMarkup.length > 0) {
      const refusal = loaderRefusalFor(currentMarkup, preset.controls);
      assert.fail(
        `${preset.label} no longer records the control inventory index.html `
          + 'produces, so the sample refuses the whole document and neither the '
          + 'advertised camera nor the advertised colouring applies.\n'
          + `  controls the markup has and the preset lacks: `
          + `${missingFromPreset.join(', ') || '(none)'}\n`
          + `  controls the preset has and the markup lacks: `
          + `${absentFromMarkup.join(', ') || '(none)'}\n`
          + `  the loader refuses it with: ${refusal ?? '(no refusal reproduced)'}\n`
          + '  re-save and repin every published preset; see the header of this file.\n'
          + '  a control the preset has and the markup lacks has one other '
          + 'possible cause: a module that creates it inside the sidebar at '
          + 'runtime without a data-state-serializer-skip marker, which this '
          + 'file cannot see and which is its own defect.',
      );
    }

    const typeDisagreements = currentInventoryKeys
      .filter(key => preset.controls[key].type !== currentInventory[key].type)
      .map(key => `${key} (markup ${currentInventory[key].type}, preset `
        + `${preset.controls[key].type})`);
    assert.deepEqual(
      typeDisagreements,
      [],
      `${preset.label} declares a control type the markup no longer has; the `
        + 'loader refuses each of these with `must declare current type`, and '
        + 'the preset has to be re-saved and repinned',
    );
  }
});

test('a control added to the markup fails the guard and is named', () => {
  assert.ok(
    !indexHtml.includes(`id="${PROBE_ID}"`),
    `index.html must not already carry #${PROBE_ID}`,
  );
  const added = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<input type="checkbox" id="${PROBE_ID}" />`,
  ));

  assert.ok(
    Object.hasOwn(added.controls, PROBE_ID),
    'the added control must enter the inventory, or this edit proves nothing',
  );
  const newKeys = Object.keys(added.controls).filter(
    key => !Object.hasOwn(currentInventory, key),
  );
  assert.deepEqual(
    newKeys,
    [PROBE_ID],
    'exactly the added control must be new; anything else means the edit '
      + 'disturbed the surrounding markup',
  );

  // A preset saved before the control existed is exactly today's inventory.
  const stalePreset = currentInventory;
  assert.equal(
    loaderRefusalFor(added, stalePreset),
    `Session UI state is missing current control "${PROBE_ID}".`,
    'the loader must name the control the stale preset lacks, and this is the '
      + 'message CEL-0224 showed the user',
  );
});

test('a control removed from the markup fails the guard and is named', () => {
  const removedId = anchorInput.id;
  const reduced = deriveInventory(removeTagOf(indexHtml, removedId));

  assert.ok(
    !Object.hasOwn(reduced.controls, removedId),
    `#${removedId} must leave the inventory when its tag is removed`,
  );
  const lostKeys = currentInventoryKeys.filter(
    key => !Object.hasOwn(reduced.controls, key),
  );
  assert.deepEqual(
    lostKeys,
    [removedId],
    'exactly the removed control must disappear; anything else means the edit '
      + 'disturbed the surrounding markup',
  );

  // A preset saved while the control still existed carries a key the interface
  // no longer has. That is equally stale, and equally fatal.
  const stalePreset = currentInventory;
  assert.equal(
    loaderRefusalFor(reduced, stalePreset),
    `Session UI control "${removedId}" does not exist in the current interface.`,
    'the loader must name the control the stale preset still carries',
  );
});

test('a control inside a skip-marked subtree does not trip the guard', () => {
  const snippet = `<input type="checkbox" id="${PROBE_ID}" />`;
  const skipped = deriveInventory(
    insertInsideFirstSkippedBlock(indexHtml, snippet),
  );

  const probe = findById(skipped.documentRoot, PROBE_ID);
  assert.ok(probe !== null, 'the probe must land in the parsed markup');
  assert.ok(
    probe.closest('[data-state-serializer-skip]') !== null,
    'the probe must land inside a skip-marked subtree, or this test is '
      + 'measuring the wrong thing',
  );
  assert.ok(
    skipped.sidebar.querySelectorAll('input[id]').some(
      element => element.id === PROBE_ID,
    ),
    'the probe must land inside the sidebar the serializer is handed',
  );

  assert.deepEqual(
    Object.keys(skipped.controls).sort(),
    currentInventoryKeys,
    'a control under data-state-serializer-skip is not serialized, so adding '
      + 'one must not invalidate a single published preset',
  );

  // The same control outside the skip subtree does enter the inventory. Without
  // this the test above would also pass if the probe had simply been dropped.
  const notSkipped = deriveInventory(
    insertAfterTagOf(indexHtml, anchorInput.id, snippet),
  );
  assert.ok(
    Object.hasOwn(notSkipped.controls, PROBE_ID),
    'the identical control outside the skip subtree must be inventoried, '
      + 'which is what proves the exclusion above is the skip marker',
  );
});

test('a control whose input type is not serialized does not trip the guard', () => {
  const serializedType = currentInventory[anchorInput.id].type;
  const radio = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<input type="radio" id="${PROBE_ID}" />`,
  ));

  assert.ok(
    radio.sidebar.querySelectorAll('input[id]').some(
      element => element.id === PROBE_ID,
    ),
    'the probe must land in the sidebar as an identified input',
  );
  assert.deepEqual(
    Object.keys(radio.controls).sort(),
    currentInventoryKeys,
    'a radio is not one of the serialized input types, so adding one must not '
      + 'invalidate a published preset. If this fails because the serialized '
      + 'types changed, every preset does need re-saving',
  );

  // Only the type differs between the two edits, so the inventory reacting to
  // that difference is what proves the exclusion is keyed on the type.
  const serialized = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<input type="${serializedType}" id="${PROBE_ID}" />`,
  ));
  assert.ok(
    Object.hasOwn(serialized.controls, PROBE_ID),
    `the same control declared type="${serializedType}" must be inventoried, `
      + 'which is what proves the exclusion above is the input type',
  );
});

test('a domain-owned control does not trip the guard wherever it sits', () => {
  // Found rather than named: an identified input in the sidebar, outside every
  // skip-marked subtree, that the inventory does not carry, and that *would* be
  // carried under a different identifier. Only an identifier-keyed filter can
  // produce that, which today is DOMAIN_OWNED_IDS.
  const excluded = currentMarkup.sidebar
    .querySelectorAll('input[id]')
    .filter(element => element.closest('[data-state-serializer-skip]') === null)
    .filter(element => !Object.hasOwn(currentInventory, element.id))
    .filter((element) => {
      const renamed = deriveInventory(
        indexHtml.replace(`id="${element.id}"`, `id="${PROBE_ID}"`),
      );
      return Object.hasOwn(renamed.controls, PROBE_ID);
    });

  assert.ok(
    excluded.length > 0,
    'the sidebar must hold at least one identifier-excluded input, or this '
      + 'mechanism is no longer exercised anywhere and the assertion below '
      + 'would be vacuous',
  );
  const domainOwned = excluded[0];

  // Moving it does not change what is serialized: the exclusion follows the
  // identifier, not the position. Rearranging a panel must not invalidate a
  // published preset.
  const relocated = deriveInventory(insertAfterTagOf(
    removeTagOf(indexHtml, domainOwned.id),
    anchorInput.id,
    tagTextOf(indexHtml, domainOwned.id),
  ));
  assert.ok(
    relocated.sidebar.querySelectorAll('input[id]').some(
      element => element.id === domainOwned.id,
    ),
    `#${domainOwned.id} must still be present after being relocated`,
  );
  assert.deepEqual(
    Object.keys(relocated.controls).sort(),
    currentInventoryKeys,
    `#${domainOwned.id} is restored by its own feature rather than by the `
      + 'generic contributor, so moving it must not invalidate a published '
      + 'preset',
  );
});
