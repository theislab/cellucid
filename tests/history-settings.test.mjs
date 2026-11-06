/**
 * History settings (`assets/js/app/history/history-settings.js`, History v2
 * §3.15.5): every switch on by default, the name unset; a browser's choices
 * kept in localStorage and told to every listener; the detail switches name
 * the domains the history leaves out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_SETTINGS, historySettings, offDomainsOf, onHistorySettingsChange, setHistorySetting,
} from '../assets/js/app/history/history-settings.js';

function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

test('every switch is on by default and nobody is named', () => {
  const settings = historySettings(storage());
  for (const [key, setting] of Object.entries(HISTORY_SETTINGS)) {
    assert.equal(settings[key], setting.kind === 'boolean' ? true : null, key);
  }
  assert.deepEqual(offDomainsOf(settings), []);
  assert.deepEqual(historySettings(null), settings, 'no localStorage keeps every default');
});

test('choices are kept and told; the detail switches leave camera and layout out', () => {
  const kept = storage();
  const told = [];
  const stop = onHistorySettingsChange(settings => told.push(settings));
  setHistorySetting('recordCamera', false, kept);
  setHistorySetting('recordLayout', false, kept);
  setHistorySetting('personName', '  Ada   Lovelace ', kept);
  stop();
  const settings = historySettings(kept);
  assert.deepEqual(offDomainsOf(settings), ['camera', 'layout']);
  assert.equal(settings.personName, 'Ada Lovelace');
  assert.equal(told.length, 3);
  setHistorySetting('personName', '   ', kept);
  assert.equal(historySettings(kept).personName, null);
  assert.throws(() => setHistorySetting('recordCamera', 'no', kept), /on or off/);
  assert.throws(() => setHistorySetting('personName', 3, kept), /a name or nothing/);
  assert.throws(() => setHistorySetting('pictures', true, kept), /no history setting/);
});
