/**
 * A browser that keeps nothing for the site (site data blocked, a sandboxed
 * frame, some private windows) throws on the very read of `localStorage`.
 * Found 2026-11-11 (R9E-5): with site data blocked Cellucid did not start at
 * all ("Cellucid could not start"), because the theme bootstrap, the
 * antialiasing preference, the analysis debug switch and the history settings
 * each read the store themselves; others had private guarded copies.
 *
 * Contract: every module reaches Web Storage through `utils/web-storage.js`,
 * which answers null where the browser gives none; a preference that cannot
 * be kept holds for the page.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { webStorage, webStorageKeeps } from '../assets/js/utils/web-storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'assets/js');

/** Classic scripts run before any module and cannot import the helper. */
const CLASSIC_SCRIPTS = new Set([
  'app/ui/core/theme-init.js',
  'app/ui/core/viewport-init.js',
]);

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** The code of a module without comments and string literals. */
function codeOf(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

test('no module but utils/web-storage.js reads localStorage or sessionStorage itself', async () => {
  const offenders = [];
  for (const file of await sources(JS)) {
    const rel = path.relative(JS, file).split(path.sep).join('/');
    if (rel === 'utils/web-storage.js' || CLASSIC_SCRIPTS.has(rel)) continue;
    const code = codeOf(await readFile(file, 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, index) => {
      // A property of that name (`storage.localStorage`, `{ localStorage: … }`)
      // is not the store; the store read off a window object is.
      if (/(?<![.\w])(localStorage|sessionStorage)\b(?!\s*:)/.test(line) ||
        /\b(globalThis|window|self|defaultView|ownerWindow|windowOwner|win|scope)\??\.(localStorage|sessionStorage)\b/.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the classic scripts read storage only inside a try', async () => {
  for (const rel of CLASSIC_SCRIPTS) {
    const code = codeOf(await readFile(path.join(JS, rel), 'utf8'));
    const reads = [...code.matchAll(/\b(localStorage|sessionStorage)\.getItem\(/g)];
    assert.ok(reads.length > 0, rel);
    for (const read of reads) {
      const before = code.slice(0, read.index);
      assert.ok(before.lastIndexOf('try {') > before.lastIndexOf('}'), `${rel} reads storage outside a try`);
    }
  }
});

test('webStorage answers null where the browser refuses the store, and the store where it gives one', () => {
  const blocked = {};
  Object.defineProperty(blocked, 'localStorage', {
    get() { throw new Error('SecurityError: access is denied for this document'); },
  });
  assert.equal(webStorage('localStorage', blocked), null);
  assert.equal(webStorage('sessionStorage', {}), null);
  assert.equal(webStorage('localStorage', null), null);
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  assert.equal(webStorage('localStorage', { localStorage: store }), store);
  assert.throws(() => webStorage('indexedDB', {}), /localStorage.*sessionStorage/);
});

test('webStorageKeeps is false where nothing is kept or the store refuses a write', () => {
  const blocked = {};
  Object.defineProperty(blocked, 'localStorage', { get() { throw new Error('denied'); } });
  assert.equal(webStorageKeeps(blocked), false);
  const full = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.equal(webStorageKeeps({ localStorage: full }), false);
  const kept = new Map();
  const store = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value), removeItem: key => kept.delete(key) };
  assert.equal(webStorageKeeps({ localStorage: store }), true);
  assert.equal(kept.size, 0);
});

test('a history setting the browser does not keep holds for the page', async () => {
  const { historySettings, setHistorySetting } = await import('../assets/js/app/history/history-settings.js');
  assert.equal(historySettings(null).autosave, true);
  setHistorySetting('autosave', false, null);
  assert.equal(historySettings(null).autosave, false);
  const refusing = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } };
  setHistorySetting('recordCamera', false, refusing);
  assert.equal(historySettings(refusing).recordCamera, false);
  setHistorySetting('autosave', true, null);
  setHistorySetting('recordCamera', true, null);
});

test('the antialiasing preference with no store is automatic and its choice is made, not kept', async () => {
  const { resolveAntialiasPreference, writeAntialiasPreference } = await import('../assets/js/app/ui/core/antialias-preference.js');
  assert.deepEqual(resolveAntialiasPreference(null), { mode: 'auto', discarded: null });
  assert.equal(writeAntialiasPreference(null, 'on'), false);
  const refusing = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.equal(writeAntialiasPreference(refusing, 'off'), false);
});

test('the analysis debug switch reads as off where the browser keeps nothing', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://www.cellucid.com/' } } });
  try {
    const { debug, isDebugMode } = await import(`../assets/js/app/analysis/shared/debug-utils.js?blocked=${Date.now()}`);
    assert.equal(isDebugMode(), false);
    debug('Probe', 'no throw');
  } finally {
    if (before === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, 'localStorage', before);
    if (windowBefore === undefined) delete globalThis.window; else Object.defineProperty(globalThis, 'window', windowBefore);
  }
});
