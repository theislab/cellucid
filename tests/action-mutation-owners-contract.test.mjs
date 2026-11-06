/**
 * No state changes outside the action layer, statically: every call of a
 * method that changes a state domain's value (`mutates` in
 * `assets/js/app/actions/classification.js`) is in a module that owns it
 * (`MUTATION_OWNERS`: an action's implementation, a domain owner, an
 * observation recorder, a dataset's publication), and calls only the methods
 * its entry names. A control that calls one directly fails here, naming the
 * file, the line, the method and the action to dispatch instead. An owner
 * entry that no longer holds (its module gone, a method it no longer calls)
 * fails too, so the list cannot grow stale, and so does a call of an
 * underscore member of the state outside `app/state/`.
 *
 * AST-free, like the other source scans (`abort-listener-contract`,
 * `per-cell-allocation-contract`): comments are stripped, then every
 * `.name(`, `?.name(` and `.name?.(` of a `mutates` name is a call of it.
 * A same-named method of another object is declared in `NAME_COLLISIONS` by
 * module, receiver and method. A method passed around by reference
 * (`.bind`, a variable) is out of reach here; the control walk
 * (`tests/browser/helpers/control-walk.mjs`) catches what that changes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_STATE_METHODS, MUTATION_OWNERS, NAME_COLLISIONS, VIEWER_METHODS, mutatingNames,
} from '../assets/js/app/actions/classification.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'assets', 'js');
const STATE_LAYER = 'assets/js/app/state/';
const CLASSIFICATION = 'app/actions/classification.js';

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (line, before) => before + ' '.repeat(line.length - before.length));
}

/** Each `mutates` name with what it changes and the actions that own it (both tables). */
function mutatingMethods() {
  const out = new Map();
  for (const [label, table] of [['DataState', DATA_STATE_METHODS], ['viewer', VIEWER_METHODS]]) {
    for (const name of mutatingNames(table)) {
      const entry = out.get(name) ?? { tables: [], domains: new Set(), actions: new Set() };
      entry.tables.push(label);
      for (const domain of table[name].domains) entry.domains.add(domain);
      for (const type of table[name].actions) entry.actions.add(type);
      out.set(name, entry);
    }
  }
  return out;
}

/** Every call in `text` (comments stripped): receiver, method, line. */
function callsIn(text) {
  const lineStarts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const lineAt = offset => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  // The receiver is read backwards from the dot (a pattern that also matched
  // it would try every run of indentation, quadratically).
  const receiverBefore = offset => {
    let end = offset;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    let start = end;
    while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
    return { receiver: text.slice(start, end), at: start === end ? offset : start };
  };
  const calls = [];
  const pattern = /\??\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g;
  for (const match of text.matchAll(pattern)) {
    if (text[match.index - 1] === '.') continue; // a spread or a rest, never a call's dot
    const { receiver, at } = receiverBefore(match.index);
    calls.push({ receiver, method: match[1], line: lineAt(at) });
  }
  return calls;
}

/** Every module under assets/js: its path from the repository root, and its text without comments. */
function modules() {
  return sources(SCRIPTS).map(file => ({
    relative: path.relative(root, file).split(path.sep).join('/'),
    text: withoutComments(readFileSync(file, 'utf8')),
  }));
}

/** @param {Array<{relative: string, text: string}>} files */
function scan(files) {
  const mutating = mutatingMethods();
  const owners = new Map(MUTATION_OWNERS.filter(entry => entry.module !== undefined).map(entry => [entry.module, entry]));
  const prefixes = MUTATION_OWNERS.filter(entry => entry.prefix !== undefined);
  const collisions = NAME_COLLISIONS;
  const offences = [];
  const underscore = [];
  const used = new Map([...owners.keys()].map(module => [module, new Set()]));
  const prefixUsed = new Set();
  const collisionUsed = new Set();
  for (const { relative, text } of files) {
    const prefix = prefixes.find(entry => relative.startsWith(entry.prefix)) ?? null;
    for (const { receiver, method, line } of callsIn(text)) {
      if (method.startsWith('_') && /state$/i.test(receiver) && !relative.startsWith(STATE_LAYER)) {
        underscore.push(`${relative}:${line} calls ${receiver}.${method}(): an underscore member of the state is the state layer's own; `
          + 'call a public DataState method (classified in app/actions/classification.js) or dispatch an action');
      }
      const info = mutating.get(method);
      if (info === undefined) continue;
      const collision = collisions.find(entry => entry.module === relative && entry.receiver === receiver && entry.methods.includes(method));
      if (collision !== undefined) {
        collisionUsed.add(`${collision.module}|${receiver}|${method}`);
        continue;
      }
      if (prefix !== null) {
        prefixUsed.add(prefix.prefix);
        continue;
      }
      const owner = owners.get(relative);
      if (owner !== undefined && owner.methods.includes(method)) {
        used.get(relative).add(method);
        continue;
      }
      const actions = [...info.actions];
      offences.push(
        `${relative}:${line} calls ${method}() (${info.tables.join(' and ')}: changes ${[...info.domains].join(', ')}; `
        + `owned by ${actions.join(', ')}): dispatch ${actions[0]} through getActions() `
        + '(app/actions/control-dispatch.js dispatchFromControl) instead, or, if this module is the action\'s '
        + `implementation, add it to MUTATION_OWNERS in ${CLASSIFICATION} with why`,
      );
    }
  }
  return { offences, underscore, used, prefixUsed, collisionUsed, owners, prefixes };
}

const result = scan(modules());

test('no module changes state outside the action layer', () => {
  assert.deepEqual(result.offences, []);
});

test('no module outside the state layer calls an underscore member of the state', () => {
  assert.deepEqual(result.underscore, []);
});

test('every owner entry still holds: its module exists and calls every method it lists', () => {
  const stale = [];
  for (const [module, entry] of result.owners) {
    if (typeof entry.why !== 'string' || entry.why.length < 20) stale.push(`${module}: say why it owns these calls`);
    if (!existsSync(path.join(root, module))) {
      stale.push(`${module} no longer exists: remove its entry from MUTATION_OWNERS in ${CLASSIFICATION}`);
      continue;
    }
    if (result.prefixes.some(prefix => module.startsWith(prefix.prefix))) {
      stale.push(`${module} is inside a prefix entry already: remove its own entry`);
    }
    const mutating = mutatingMethods();
    for (const method of entry.methods) {
      if (!mutating.has(method)) {
        stale.push(`${module} lists ${method}(), which changes no state (not "mutates"): remove it from its entry`);
      } else if (!result.used.get(module).has(method)) {
        stale.push(`${module} no longer calls ${method}(): remove it from its entry in MUTATION_OWNERS`);
      }
    }
  }
  for (const entry of result.prefixes) {
    if (!result.prefixUsed.has(entry.prefix)) stale.push(`prefix ${entry.prefix} calls no method that changes state: remove its entry`);
  }
  assert.equal(new Set(MUTATION_OWNERS.map(entry => entry.module ?? entry.prefix)).size, MUTATION_OWNERS.length, 'one entry per module');
  assert.deepEqual(stale, []);
});

test('every name collision still occurs where it is declared', () => {
  const stale = [];
  for (const entry of NAME_COLLISIONS) {
    for (const method of entry.methods) {
      if (!result.collisionUsed.has(`${entry.module}|${entry.receiver}|${method}`)) {
        stale.push(`${entry.module} no longer calls ${entry.receiver}.${method}(): remove it from NAME_COLLISIONS in ${CLASSIFICATION}`);
      }
    }
  }
  assert.deepEqual(stale, []);
});

test('a control that changes state itself is named with the action to dispatch; an owner calling another method is too', () => {
  const { offences, underscore } = scan([
    { relative: 'assets/js/app/ui/modules/some-control.js', text: "button.onclick = () => state.renameField(source, index, 'x');" },
    { relative: 'assets/js/app/ui/modules/field-selector.js', text: 'state.setActiveField(0); state.hideAllCategories(field);' },
    { relative: 'assets/js/app/ui/modules/other.js', text: 'this._state._syncActiveContext();' },
    { relative: 'assets/js/app/state/managers/inside.js', text: 'this._syncActiveContext(); state.renameField(a);' },
  ]);
  assert.equal(offences.length, 2);
  assert.match(offences[0], /^assets\/js\/app\/ui\/modules\/some-control\.js:1 calls renameField\(\) \(DataState: changes field-overlays; owned by field\.rename\): dispatch field\.rename through getActions\(\)/);
  assert.match(offences[1], /^assets\/js\/app\/ui\/modules\/field-selector\.js:1 calls hideAllCategories\(\) .*dispatch filter\.category\.all/);
  assert.equal(underscore.length, 1);
  assert.match(underscore[0], /^assets\/js\/app\/ui\/modules\/other\.js:1 calls _state\._syncActiveContext\(\)/);
});

test('the scan sees every way a call is spelt, and only calls', () => {
  const calls = callsIn(withoutComments([
    'state.renameField(a);',
    'state?.deleteField(b);',
    'state.ensureHighlightPage?.();',
    'viewer\n  .setPointSize(2);',
    '// state.removeFilter(c);',
    '/* viewer.resetCamera(); */',
    "const text = 'http://example.org'; state.setActiveView(id);",
    'const ref = state.setCellVisibility;',
  ].join('\n')));
  assert.deepEqual(
    calls.map(({ receiver, method, line }) => `${receiver}.${method}@${line}`),
    ['state.renameField@1', 'state.deleteField@2', 'state.ensureHighlightPage@3', 'viewer.setPointSize@4', 'state.setActiveView@8'],
  );
});
