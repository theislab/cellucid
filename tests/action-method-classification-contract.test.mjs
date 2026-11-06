/**
 * Every method of the state and of the viewer is classified
 * (`assets/js/app/actions/classification.js`): it reads, it is internal (with
 * why), or it changes a state domain's value and names the actions that own
 * the change. A method added to a `DataState` mixin or to the viewer's public
 * API without a classification fails here, naming it and what to do; so does
 * a classification of a method that is gone, an action the catalogue lacks,
 * a read named as an owner, an owner that does not touch the domain the
 * method changes, and an internal method with no known reason.
 *
 * The method lists are the real ones: `DataState.prototype` as its mixins
 * build it, and the keys of the viewer's `publicApi` literal read from
 * `rendering/viewer.js` (the control walk compares them with the keys of the
 * viewer a page creates).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_STATE_METHODS, INTERNAL_REASONS, METHOD_KINDS, VIEWER_METHODS, internal, mutatingNames, mutates, reads,
  staleClassifications, unclassified, viewerApiNames,
} from '../assets/js/app/actions/classification.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLASSIFICATION = 'assets/js/app/actions/classification.js';

/** Every public member of the state's prototype, accessors included. */
function dataStateNames() {
  return Object.getOwnPropertyNames(DataState.prototype).filter(name => name !== 'constructor' && !name.startsWith('_'));
}

function viewerNames() {
  return viewerApiNames(readFileSync(path.join(root, 'assets/js/rendering/viewer.js'), 'utf8'));
}

const TABLES = [
  { label: 'DataState', table: DATA_STATE_METHODS, constant: 'DATA_STATE_METHODS', names: dataStateNames },
  { label: 'viewer', table: VIEWER_METHODS, constant: 'VIEWER_METHODS', names: viewerNames },
];

test('every DataState method and every viewer API method is classified', () => {
  for (const { label, table, constant, names } of TABLES) {
    const missing = unclassified(names(), table);
    assert.deepEqual(
      missing.map(name => `${label}.${name} is not classified: add it to ${constant} in ${CLASSIFICATION} as reads(), `
        + 'internal(reason) or mutates(<domains>, [<action types that own it>])'),
      [],
    );
  }
});

test('no classification is kept for a method that is gone', () => {
  for (const { label, table, constant, names } of TABLES) {
    const stale = staleClassifications(names(), table);
    assert.deepEqual(
      stale.map(name => `${label}.${name} no longer exists: remove it from ${constant} in ${CLASSIFICATION}`),
      [],
    );
  }
});

test('each classification is one of the kinds, with a known reason or owning actions that touch its domains', () => {
  const catalog = getActionCatalog();
  const problems = [];
  for (const { label, table } of TABLES) {
    for (const [name, entry] of Object.entries(table)) {
      const where = `${label}.${name}`;
      if (!METHOD_KINDS.includes(entry?.kind)) {
        problems.push(`${where}: classify it with reads(), internal(reason) or mutates(domains, actions)`);
        continue;
      }
      if (entry.kind === 'internal' && !Object.hasOwn(INTERNAL_REASONS, entry.reason)) {
        problems.push(`${where}: internal reason "${entry.reason}" is none of ${Object.keys(INTERNAL_REASONS).join(', ')}`);
      }
      if (entry.kind !== 'mutates') continue;
      if (entry.domains.length === 0) problems.push(`${where}: name the state domains it changes`);
      for (const domain of entry.domains) {
        if (!DOMAIN_IDS.includes(domain)) problems.push(`${where}: "${domain}" is not a state domain (app/actions/domains.js)`);
      }
      if (entry.actions.length === 0) problems.push(`${where}: name the action types that own the change`);
      for (const type of entry.actions) {
        if (!catalog.has(type)) {
          problems.push(`${where}: "${type}" is not an action of the catalogue (app/actions/definitions/)`);
          continue;
        }
        const definition = catalog.get(type);
        if (definition.effect === 'read') {
          problems.push(`${where}: "${type}" reads; a method that changes state is owned by an action that changes it`);
          continue;
        }
        for (const domain of entry.domains) {
          if (!definition.touches.includes(domain)) {
            problems.push(`${where}: "${type}" does not touch "${domain}"; add the domain to its touches or name the action that owns the change`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the classification helpers say exactly what is missing and what is stale', () => {
  const table = { a: reads(), b: internal('wiring'), c: mutates('views', ['view.focus']) };
  assert.deepEqual(unclassified(['a', 'b', 'd'], table), ['d']);
  assert.deepEqual(staleClassifications(['a', 'b'], table), ['c']);
  assert.deepEqual(mutatingNames(table), ['c']);
  assert.deepEqual(mutates(['views', 'camera'], ['view.focus']).domains, ['views', 'camera']);
  assert.ok(Object.isFrozen(DATA_STATE_METHODS) && Object.isFrozen(VIEWER_METHODS));
});

test('the viewer API is read from the literal whatever its indentation, and what it cannot read is refused', () => {
  const source = [
    'function createViewer() {',
    '  const publicApi = {',
    '    plain(a) { return a / 2; },',
    '    shorthand,',
    "    value: () => ({ text: '}', re: /[}{]/g, tpl: `${1 + 1}}` }),",
    '    async later() {},',
    '    get size() { return 1; },',
    '\t    tabbed() {},',
    '  // a comment, then a key',
    '  misIndented(x) { return { nested: x }; },',
    '  };',
    '  return publicApi;',
    '}',
  ].join('\n');
  assert.deepEqual(viewerApiNames(source), ['plain', 'shorthand', 'value', 'later', 'size', 'tabbed', 'misIndented']);
  assert.throws(() => viewerApiNames('const publicApi = { ...other };'), /spreads another object/);
  assert.throws(() => viewerApiNames('const publicApi = { [name]: 1 };'), /computed key/);
  assert.throws(() => viewerApiNames('const api = {};'), /no longer declares/);
  // The real viewer: unique names, its disposal among them.
  const names = viewerNames();
  assert.equal(new Set(names).size, names.length, 'no viewer API name twice');
  assert.ok(names.includes('dispose') && names.includes('setCentroids'));
});
