/**
 * The published sample presets (`anndata/<id>.cellucid-session`, session
 * format 4 starting views: one tracker of one root, `published-default.js`)
 * record the *complete* settings control inventory in their root's `settings`
 * value (`app/state/domains/settings.js`), so adding one identified input to
 * the sidebar invalidates every preset that was saved before it existed. The
 * settings domain refuses the value with `Session UI state is
 * missing current control "<id>"`, the starting view fails as a whole, and the
 * visible result is that the advertised camera never applies and no field is
 * colored. Removing a control is equally fatal in the other direction: the
 * preset then carries a key the interface no longer has, and the domain
 * refuses with `... does not exist in the current interface`.
 *
 * The advertised-default browser spec builds its session bundle at runtime
 * from the page it just loaded, so its bundle and its markup can never
 * disagree — it cannot see a stale *checked-in* file. The failure would only
 * surface when someone opened a sample; this file is the guard.
 *
 * ## What this file compares
 *
 * The current control inventory is derived from `index.html` by running the
 * application's own `collectUIControls()` against a parsed copy of that
 * markup, over the part of the inventory the `settings` domain holds
 * (`createUiControlSerializer({sidebar, domains: ['settings']})`: the
 * accordion sections and the theme are the `layout` domain's, which a
 * starting view does not hold, and the centroid toggles the `views`
 * domain's). Nothing here restates which controls are serialized. The filters
 * that define the inventory — `data-state-serializer-skip` ancestors,
 * `DOMAIN_OWNED_IDS`, `SERIALIZABLE_INPUT_TYPES` and the one map that splits it
 * between domains (`controlDomainOf`) — all live in the control serializer
 * (`createUiControlSerializer`) and are applied by that module here exactly as
 * they are in the browser. A further *filter* added there is honored by this
 * file the day it lands, with no edit. That is the whole point: a restated
 * list would be the same defect one level up.
 *
 * A new *selector* is the one thing that does need an edit here, and
 * deliberately so: the parsed-markup shim below throws on a query it does not
 * implement rather than returning an empty list, because an unimplemented
 * selector answered with `[]` would silently shrink the inventory and make
 * every stale preset look current.
 *
 * The comparison is the **inventory**: the set of keys and the control type
 * each key declares. Both are decided by the markup alone, and both are what
 * a stale preset breaks.
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
 * populated from the loaded dataset, and a color input with no `value`
 * attribute reports a value the browser supplies rather than the markup. A
 * guard that judged values from static markup would fail on correct presets,
 * which is the failure mode that would make it worse than nothing. Values are
 * covered where they can be: by the browser specs, against a live page.
 *
 * ## Recovering when this fails
 *
 * The presets are not regenerated from markup — they are real saves. When a
 * control is added or removed, each published preset has to be captured again
 * and republished in `cellucid-datasets`:
 *
 *  1. run `node scripts/capture_session_preset.mjs --dataset <id> --out <save>`
 *     there: it opens the sample with its current starting view applied and
 *     saves it with the viewer's own Save;
 *  2. run `node scripts/publish_session_preset.mjs --dataset <id> --from <save>`:
 *     it makes the save's head the starting view's one root
 *     (`trimToPublishedDefault`), rebinds it to the store's identity, writes
 *     `anndata/<id>.cellucid-session`, and repins that entry's
 *     `session.bytes` and `session.sha256` in `anndata/datasets.json`;
 *  3. review and repin what that repository's own preset tests pin
 *     (`tests/session-presets-contract.test.mjs`).
 *
 * The presets are read from the `cellucid-datasets` checkout beside this
 * repository, or from the one `CELLUCID_DATASETS_ROOT` names.
 *
 * Every preset carries the same inventory, so a control change always
 * invalidates all of them, never one.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { absentSibling } from '../scripts/shared-files.mjs';
import { openHistoryFile } from '../assets/js/app/session/history-file.js';
import {
  assertPublishedDefaultProfile,
  assertPublishedDefaultRoot,
} from '../assets/js/app/session/published-default.js';
import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { createDomId } from '../assets/js/app/ui/components/dom-id.js';

const INDEX_URL = new URL('../index.html', import.meta.url);
/**
 * The `cellucid-datasets` checkout the presets are read from: the one
 * `CELLUCID_DATASETS_ROOT` names, else the one beside this repository.
 */
const NAMED_PRESET_REPOSITORY = process.env.CELLUCID_DATASETS_ROOT ?? null;
const PRESET_REPOSITORY_URL = NAMED_PRESET_REPOSITORY === null
  ? new URL('../../cellucid-datasets/', import.meta.url)
  : pathToFileURL(`${path.resolve(NAMED_PRESET_REPOSITORY)}${path.sep}`);
const PRESET_CATALOG_URL = new URL('anndata/datasets.json', PRESET_REPOSITORY_URL);
/** The part of the control inventory a starting view holds. */
const PRESET_CONTROL_DOMAINS = Object.freeze(['settings']);

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

  /** `data-*` attributes by camel-cased name, as `HTMLElement.dataset` reads them. */
  get dataset() {
    const entries = Object.entries(this.attributes)
      .filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [
        name.slice('data-'.length).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
        value,
      ]);
    return Object.freeze(Object.fromEntries(entries));
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
 * The settings control inventory the given markup would produce, as the
 * application itself computes it.
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
    () => createUiControlSerializer({ sidebar, domains: PRESET_CONTROL_DOMAINS }).collectUIControls(),
  );
  return { documentRoot, sidebar, controls };
}

const currentMarkup = deriveInventory(indexHtml);
const currentInventory = currentMarkup.controls;
const currentInventoryKeys = Object.keys(currentInventory).sort();

test('every sidebar section\'s open state is the layout\'s, a section whose controls stay out included', () => {
  // `data-state-serializer-skip` on a section keeps its controls out of the
  // settings, never the section itself: opening the State, Camera path,
  // Figure export, Community annotation or Benchmark section is a layout
  // step like any other.
  const sections = [...indexHtml.matchAll(/<details class="accordion-section"[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  assert.ok(sections.includes('state-section') && sections.includes('cinematic-camera-section'), 'the markup names its sections');
  const layout = withParsedDocument(
    currentMarkup.documentRoot,
    () => createUiControlSerializer({ sidebar: currentMarkup.sidebar, domains: ['layout'] }).collectUIControls(),
  );
  const accordions = Object.keys(layout).filter(key => key.startsWith('accordion:')).map(key => key.slice('accordion:'.length));
  assert.deepEqual(accordions.sort(), [...sections].sort());
});

/**
 * The refusal the settings domain raises for this candidate against this
 * markup (its restore validates the controls first, `restoreUIControls`).
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
      () => createUiControlSerializer({ sidebar: markup.sidebar, domains: PRESET_CONTROL_DOMAINS })
        .validateUIControls(candidateControls),
    );
  } catch (error) {
    return error.message;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Reading the published presets out of the cellucid-datasets repository.
 * ------------------------------------------------------------------ */

/**
 * The settings controls a published starting view puts back: its root's
 * `settings` value, read as the application reads a starting view (the
 * format-4 reader, the starting-view profile and its one root).
 */
async function readPresetControls(bytes, label) {
  const file = await openHistoryFile(new Blob([bytes]), { signal: null, onProgress: null });
  let eager;
  try {
    assertPublishedDefaultProfile(file.manifest);
    eager = await file.readEager();
    await file.readRest();
  } catch (error) {
    await file.cancel(error);
    throw new Error(`${label} is not a starting view this version of Cellucid reads: ${error.message}`, { cause: error });
  }
  const [root] = eager.history.trackers[0].steps;
  assertPublishedDefaultRoot(root);
  assert.ok(
    Object.hasOwn(root.after, 'settings'),
    `${label} must hold a settings value: it is the value that records the control inventory`,
  );
  const settings = eager.values.get(root.after.settings);
  assert.ok(
    settings?.controls !== null && typeof settings?.controls === 'object',
    `${label} settings must carry a controls record`,
  );
  return settings.controls;
}

/**
 * The presets the catalog advertises, or `null` when the `cellucid-datasets`
 * repository is not checked out beside this one (and none is named by
 * `CELLUCID_DATASETS_ROOT`).
 *
 * Read the way the viewer reads them: through `anndata/datasets.json`, each
 * `session` at its catalog path, held to the declared byte length and SHA-256.
 * Only an absent *repository* is a reason to skip; a present repository whose
 * catalog is missing, or advertises no session, is a defect and fails.
 */
async function readPublishedPresets() {
  let repositoryRoot;
  try {
    repositoryRoot = await stat(PRESET_REPOSITORY_URL);
  } catch {
    repositoryRoot = null;
  }
  const present = repositoryRoot?.isDirectory() === true;
  // A repository named on purpose that is not there is a mistake, not a skip.
  if (!present) {
    assert.equal(
      NAMED_PRESET_REPOSITORY,
      null,
      `CELLUCID_DATASETS_ROOT names ${NAMED_PRESET_REPOSITORY}, which is not a cellucid-datasets checkout`,
    );
  }
  if (absentSibling(present, 'the cellucid-datasets repository is not checked out beside this one')) return null;

  const catalog = JSON.parse(await readFile(PRESET_CATALOG_URL, 'utf8'));
  assert.equal(catalog.schema, 2, 'the sample catalog must be schema 2');
  const presets = [];
  for (const entry of catalog.datasets) {
    if (entry.session === undefined) continue;
    const label = `anndata/${entry.session.path}`;
    const bytes = await readFile(new URL(entry.session.path, PRESET_CATALOG_URL));
    assert.equal(bytes.byteLength, entry.session.bytes, `${label} must be the byte length the catalog declares`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.session.sha256,
      `${label} must have the SHA-256 the catalog declares`,
    );
    presets.push({
      datasetId: entry.id,
      label,
      controls: await readPresetControls(bytes, label),
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

  assert.ok(
    currentInventoryKeys.length > 0,
    'the derived inventory must not be empty, or every comparison below is '
      + 'vacuous',
  );
});

test('a group of pressed buttons is never a control: the selection tool is an input mode, not state', () => {
  // A toolbelt (one pressed button of several) decides what the next gesture
  // does, as a held key does: page chrome, no setting and no step. The real
  // one, and one added beside it, stay out.
  const probeGroupId = `${PROBE_ID}-group`;
  assert.equal(Object.hasOwn(currentInventory, 'highlight-mode'), false);
  const added = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<div id="${probeGroupId}" role="group">`
      + `<button id="${probeGroupId}-on" aria-pressed="true">On</button>`
      + `<button id="${probeGroupId}-off" aria-pressed="false">Off</button>`
      + '</div>',
  ));
  assert.deepEqual(Object.keys(added.controls).sort(), currentInventoryKeys);
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
    `${PRESET_CATALOG_URL.pathname} advertises no session; a catalog without `
      + 'presets must not read as agreement',
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
          + 'advertised camera nor the advertised coloring applies.\n'
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

/**
 * A control marked `data-session-preference` records a preference its owner
 * keeps rather than the value it shows (`holdsPreference` in `ui-controls.js`),
 * and the loader checks that record in full whatever the control's range is
 * now — so, unlike other values, it is decidable from the markup. A save taken
 * before the preference was recorded holds the value the slider showed, `0`
 * while no graph is read; restored, it would switch edges on with none shown,
 * and the loader refuses it instead. This asks the loader about each preset's
 * preference records against a sidebar of exactly those controls, as
 * `index.html` declares them, so no other control's runtime value is judged.
 */
test('every published preset records each preference the loader accepts', async (t) => {
  const presets = await readPublishedPresets();
  if (presets === null) {
    t.skip(
      'the cellucid-datasets repository is not checked out beside this one, '
        + 'so the published presets cannot be read here',
    );
    return;
  }
  // Every key of the settings inventory is a control's id (accordion
  // sections, keyed `accordion:<id>`, are the layout's).
  const preferenceElements = currentInventoryKeys
    .map(id => findById(currentMarkup.documentRoot, id))
    .filter(element => element?.dataset.sessionPreference !== undefined);
  assert.ok(
    preferenceElements.length > 0,
    'index.html marks no control data-session-preference; this guard then has '
      + 'nothing to check and must go with the last such control',
  );
  const preferenceMarkup = deriveInventory(
    `<div id="sidebar">${preferenceElements.map(element => {
      const attributes = Object.entries(element.attributes)
        .map(([name, value]) => `${name}="${value.replaceAll('"', '&quot;')}"`)
        .join(' ');
      return `<${element.tagName} ${attributes}>`;
    }).join('')}</div>`,
  );
  assert.deepEqual(
    Object.keys(preferenceMarkup.controls).sort(),
    preferenceElements.map(element => element.id).sort(),
    'the sidebar of preference controls must inventory exactly those controls',
  );
  for (const preset of presets) {
    const candidate = Object.fromEntries(
      preferenceElements.map(element => [element.id, preset.controls[element.id]]),
    );
    assert.equal(
      loaderRefusalFor(preferenceMarkup, candidate),
      null,
      `${preset.label} records a preference the loader refuses; re-save and `
        + 'repin every published preset (see the header of this file)',
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
    'the loader must name the control the stale preset lacks',
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

test('a control whose id was minted on the page never enters the inventory', () => {
  // A continuous legend rebuilds its range sliders with `createDomId` ids
  // (`minimum--1b`) on every render. A session that recorded one named a
  // control no other page has, and loading it was refused. Any minted id is
  // page-local by construction, so the serializer leaves such controls out;
  // a stable id beside it still enters.
  const mintedId = createDomId('minimum');
  const stableId = `${PROBE_ID}-stable`;
  const added = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<input id="${mintedId}" type="range" min="0" max="1" step="0.1" value="0.5">`
      + `<input id="${stableId}" type="checkbox">`,
  ));
  assert.equal(Object.hasOwn(added.controls, mintedId), false);
  assert.equal(Object.hasOwn(added.controls, stableId), true);
  // An id made from a minted one (`<minted>-trigger`) is the page's own too.
  const derivedId = `${createDomId('maximum')}-input`;
  const derived = deriveInventory(insertAfterTagOf(
    indexHtml,
    anchorInput.id,
    `<input id="${derivedId}" type="checkbox">`,
  ));
  assert.equal(Object.hasOwn(derived.controls, derivedId), false);
});
