/**
 * The one shortcut table (`assets/js/app/ui/onboarding/shortcut-table.js`)
 * against every key the app answers.
 *
 * The Keyboard shortcuts panel and the docs page are drawn from the table and
 * the page's key listener answers from it, so a panel written by hand beside
 * five separate key listeners, held together by a test reading both, cannot
 * miss Ctrl+Y, the History list's keys or the keys that move a panel, a page
 * or a category. These tests pin the rest: every key a page-wide listener or a keyed widget answers is a
 * row, every row is served, and the docs page is what the table writes.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  SHORTCUT_COMMANDS, SHORTCUT_GROUPS, SHORTCUT_PRESSES, renderShortcutPanel, shortcutGroup, shortcutKeysText,
} from '../assets/js/app/ui/onboarding/shortcut-table.js';
import { NAVIGATION_KEYS, NAVIGATION_KEY_MODES } from '../assets/js/rendering/navigation-keys.js';
import { MOVE_KEYS } from '../assets/js/app/ui/keyboard-move.js';
import { historyKeyOf } from '../assets/js/app/ui/modules/state/keyboard.js';
import { renderShortcutReference, shortcutReferencePath } from '../scripts/generate-shortcut-reference.mjs';
import { skipAbsentSibling } from '../scripts/shared-files.mjs';
import { sourceFiles } from './helpers/source-files.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFile(new URL(relative, ROOT), 'utf8');

const [viewerSource, highlightRenderer, modeUiSource, graphSource, indexHtml] = await Promise.all([
  read('assets/js/rendering/viewer.js'),
  read('assets/js/rendering/highlight-renderer.js'),
  read('assets/js/app/ui/modules/highlight/mode-ui.js'),
  read('assets/js/app/ui/modules/state/graph.js'),
  read('index.html'),
]);

const rows = SHORTCUT_GROUPS.flatMap(group => group.rows.map(row => ({ ...row, group: group.id })));
const rowsSaying = pattern => rows.filter(row => pattern.test(row.label));
const comboKeys = row => row.combos.map(combo => combo.keys);

const sources = new Map();
for (const file of sourceFiles('assets/js')) sources.set(file.relative, await readFile(file.path, 'utf8'));

// ---------------------------------------------------------------------------
// The table drives the panel and the page's key listener
// ---------------------------------------------------------------------------

test('every group has its list in the panel, and the panel is drawn from the table', () => {
  for (const group of SHORTCUT_GROUPS) {
    assert.match(indexHtml, new RegExp(`data-shortcut-group="${group.id}"`), `the panel has a list for ${group.id}`);
    assert.match(indexHtml, new RegExp(`data-info-tip="shortcuts-${group.id}"`), `${group.id} has its (i)`);
  }
  assert.doesNotMatch(indexHtml, /class="shortcut-item"/, 'no row is written by hand in index.html');

  // Drawn into a stand-in document: one item per row, the keys as <kbd>.
  const lists = new Map();
  const make = tag => {
    const node = { tagName: tag.toUpperCase(), children: [], className: '', textContent: '', title: '' };
    node.append = (...parts) => node.children.push(...parts);
    node.querySelectorAll = () => [];
    return node;
  };
  const ownerDocument = {
    createElement: make,
    querySelector: selector => {
      const id = /data-shortcut-group="([^"]+)"/.exec(selector)[1];
      if (!lists.has(id)) lists.set(id, make('div'));
      return lists.get(id);
    },
  };
  renderShortcutPanel(ownerDocument);
  for (const group of SHORTCUT_GROUPS) {
    const items = lists.get(group.id).children;
    assert.equal(items.length, group.rows.length, group.id);
    items.forEach((item, index) => {
      const [desc, keys] = item.children;
      assert.equal(desc.textContent, group.rows[index].label);
      const shown = keys.children.map(part => (typeof part === 'string' ? part : `<${part.textContent}>`)).join('');
      const { combos } = group.rows[index];
      const spaced = combos.length > 1 && combos.some(combo => combo.keys.length > 1 || combo.gesture !== undefined);
      const expected = combos
        .map(combo => combo.keys.map(key => `<${key}>`).join('+') + (combo.gesture === undefined ? '' : `+${combo.gesture}`))
        .join(spaced ? ' / ' : '');
      assert.equal(shown, expected, `${group.rows[index].label}`);
    });
  }
});

test('every key press the table binds runs a command one module provides', () => {
  assert.ok(SHORTCUT_PRESSES.size >= 12);
  for (const command of SHORTCUT_COMMANDS) {
    const providers = [...sources].filter(([, source]) => source.includes(`provideShortcut('${command}'`)).map(([file]) => file);
    assert.equal(providers.length, 1, `${command} is provided by ${providers.join(', ') || 'no module'}`);
  }
  for (const [file, source] of sources) {
    for (const [, command] of source.matchAll(/provideShortcut\('([^']+)'/g)) {
      assert.ok(SHORTCUT_COMMANDS.has(command), `${file} provides "${command}", which no key of the table runs`);
    }
  }
});

test('every page-wide key listener serves rows of the table, or is a widget\'s own', () => {
  // A listener on the document or the window answers keys wherever focus
  // is: each is one of these, and a new one fails here until its keys are
  // rows of the table (or it is shown to be no shortcut).
  const PAGE_WIDE = Object.freeze({
    'app/ui/onboarding/keyboard-shortcuts.js': 'the table\'s key presses',
    'app/ui/modules/state/keyboard.js': 'General: undo and redo',
    'app/ui/modules/highlight/mode-ui.js': 'Selection: Esc cancels, then leaves Select mode',
    'app/ui/modules/state/tour.js': 'History list: Esc stops a tour',
    'rendering/viewer.js': 'the camera keys, Alt (selection) and Esc (pointer)',
    'app/ui/components/info-popovers.js': 'an open (i) popover\'s own Escape and Tab',
    'app/ui/components/full-text-reveal.js': 'an open full-text popover\'s own Escape',
    'app/ui/core/press-guard.js': 'no shortcut: a held Enter or Space does not press a primary button twice',
    'app/ui/modules/cinematic-camera/transport-bar.js': 'no shortcut: Tab shows the camera path bar',
  });
  const pageWide = /(?:document|documentRef|documentOwner|ownerDocument|doc|window|root)\??\.addEventListener\(\s*'key(?:down|up)'|listen\(\s*(?:document|documentOwner|ownerDocument|doc|window)\s*,\s*'key(?:down|up)'|addPageInputListenerWithCleanup\(window,\s*'key/;
  const found = [...sources].filter(([, source]) => pageWide.test(source)).map(([file]) => file).sort();
  assert.deepEqual(found, Object.keys(PAGE_WIDE).sort());
  assert.deepEqual(rowsSaying(/^stop a tour/i).map(comboKeys), [[['Esc']]]);
});

// ---------------------------------------------------------------------------
// The camera keys
// ---------------------------------------------------------------------------

function viewerFunctionBody(name, nextName) {
  const start = viewerSource.indexOf(`function ${name}(`);
  const end = viewerSource.indexOf(`function ${nextName}(`, start);
  assert.ok(start !== -1 && end > start, `viewer.js must still define ${name} before ${nextName}`);
  return viewerSource.slice(start, end);
}

test('the viewer moves the camera by exactly the movements each mode is listed with', () => {
  const freefly = viewerFunctionBody('updateFreefly', 'updateOrbitPlanarKeys');
  const orbitPlanar = viewerFunctionBody('updateOrbitPlanarKeys', 'syncFreeflyFromOrbit');
  const read = body => new Set([...body.matchAll(/keyShare\('([a-zA-Z]+)'\)/g)].map(match => match[1]));
  const listed = mode => new Set(Object.keys(NAVIGATION_KEY_MODES).filter(movement => NAVIGATION_KEY_MODES[movement].includes(mode)));
  assert.deepEqual(read(freefly), listed('free'), 'free-fly');
  assert.deepEqual(listed('orbit'), listed('planar'));
  assert.deepEqual(read(orbitPlanar), listed('orbit'), 'orbit and planar');
  assert.doesNotMatch(viewerSource, /activeKeys\.has\('/, 'no camera key is named outside NAVIGATION_KEYS');
});

test('every camera key is a row, under the group that names its modes', () => {
  const camera = rows.filter(row => row.movements !== undefined);
  const listedMovements = camera.flatMap(row => row.movements).sort();
  assert.deepEqual(listedMovements, Object.keys(NAVIGATION_KEYS).sort(), 'each movement once');
  for (const row of rowsSaying(/^zoom (in|out)$/i)) assert.notEqual(row.group, 'free-fly');
  const wasd = rows.find(row => shortcutKeysText(row) === 'W A S D');
  assert.equal(wasd.group, 'navigation');
  assert.match(wasd.label, /move/i, 'W A S D also move the free-fly camera');
  assert.deepEqual(comboKeys(rowsSaying(/^up \/ down$/i)[0]), [['E'], ['Q']]);
  assert.match(viewerSource, /pointerLockActive[\s\S]{0,120}?code === 'Escape'[\s\S]{0,200}?exitPointerLock\(\)/);
  assert.equal(rowsSaying(/release pointer/i)[0].group, 'free-fly');
});

// ---------------------------------------------------------------------------
// Undo and redo, selection
// ---------------------------------------------------------------------------

test('the undo and redo rows name every chord the history answers', () => {
  const press = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(historyKeyOf(press('z', { ctrlKey: true }), false), 'undo');
  assert.equal(historyKeyOf(press('Z', { ctrlKey: true, shiftKey: true }), false), 'redo');
  assert.equal(historyKeyOf(press('y', { ctrlKey: true }), false), 'redo', 'Ctrl+Y off a Mac');
  assert.equal(historyKeyOf(press('y', { ctrlKey: true }), true), null, 'not on a Mac');
  assert.deepEqual(comboKeys(rowsSaying(/^undo/i)[0]), [['Ctrl', 'Z']]);
  assert.deepEqual(comboKeys(rowsSaying(/^redo$/i)[0]), [['Shift', 'Ctrl', 'Z'], ['Ctrl', 'Y']]);
});

function assertOneSelectionGate() {
  assert.match(
    highlightRenderer,
    /handlePointerDown\(e\) \{\s*\n\s*const combine = resolveSelectionGestureCombine\(e, this\.selectMode\);\s*\n\s*if \(combine === null\) return false;/,
  );
}

test('the selection rows name the modifiers the one selection gate reads', () => {
  assertOneSelectionGate();
  assert.deepEqual(rowsSaying(/add to selection/i).map(row => row.combos), [[{ keys: ['Shift', 'Alt'], gesture: 'click' }]]);
  assert.deepEqual(rowsSaying(/^subtract$/i).map(row => row.combos), [[{ keys: ['Ctrl', 'Alt'], gesture: 'click' }]]);
  // Plain Shift+drag pans: no row promises a selection from Shift alone.
  assert.match(viewerSource, /\} else if \(e\.button === 2 \|\| e\.shiftKey\) \{\s*\n\s*beginCameraDrag\(e\.clientX, e\.clientY, 'pan'\);/);
  for (const row of shortcutGroup('selection').rows) {
    for (const combo of row.combos) {
      if (combo.keys.includes('Shift')) assert.ok(combo.keys.includes('Alt'), row.label);
    }
  }
  // Only the lasso draws an area.
  for (const row of rows.filter(each => each.combos.some(combo => combo.gesture === 'drag'))) {
    assert.doesNotMatch(row.label, /area/i);
  }
});

test('Escape cancels a selection, then leaves Select mode, as the Selection rows say', () => {
  assert.match(
    modeUiSource,
    /listen\(documentOwner, 'keydown', event => \{\s*\n\s*if \(!isUnclaimedEscape\(event\)\) return;\s*\n\s*if \(!cancelActiveSelection\(\) && !leaveSelectMode\(\)\) return;/,
  );
  for (const label of [/^cancel selection$/i, /^leave select mode$/i]) {
    const [row] = rowsSaying(label);
    assert.equal(row.group, 'selection');
    assert.deepEqual(comboKeys(row), [['Esc']]);
  }
  assert.deepEqual(comboKeys(rowsSaying(/^clear highlights$/i)[0]), [['X']]);
});

// ---------------------------------------------------------------------------
// Keyed widgets: the History list and the move grammar
// ---------------------------------------------------------------------------

test('every key the History list answers is a row of its group, and every row a key it answers', () => {
  const start = graphSource.indexOf("container.addEventListener('keydown'");
  const end = graphSource.indexOf("container.addEventListener('focusin'", start);
  assert.ok(start !== -1 && end > start, 'the History list\'s key handler');
  const body = graphSource.slice(start, end);
  const answered = new Set([
    ...[...body.matchAll(/case '([^']+)':/g)].map(match => match[1]),
    ...[...body.matchAll(/key(?:\.toLowerCase\(\))? === '([^']+)'/g)].map(match => match[1]),
  ]);
  const listed = new Set(shortcutGroup('history').rows.flatMap(row => row.handles ?? []));
  assert.deepEqual([...answered].sort(), [...listed].sort());
});

test('the move grammar\'s keys are the Moving by keys rows', () => {
  const listed = new Set(shortcutGroup('move').rows.flatMap(row => row.handles));
  assert.deepEqual([...listed].sort(), Object.values(MOVE_KEYS).flat().sort());
});

// ---------------------------------------------------------------------------
// The docs
// ---------------------------------------------------------------------------

test('the docs page is what the table writes', async t => {
  const page = shortcutReferencePath();
  if (skipAbsentSibling(t, existsSync(path.dirname(page)), `no docs tree at ${path.dirname(page)} (set CELLUCID_PYTHON_DOCS)`)) return;
  const current = await readFile(page, 'utf8').catch(() => null);
  assert.equal(current, renderShortcutReference(), 'run node scripts/generate-shortcut-reference.mjs');
});
