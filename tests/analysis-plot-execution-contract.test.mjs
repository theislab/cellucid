import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../assets/js/app/analysis/', import.meta.url);

async function source(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker ${end}`);
  return text.slice(startIndex, endIndex);
}

test('Plotly update paths never render again after an execution failure', async () => {
  const lifecycle = await source('shared/plot-lifecycle.js');
  const factory = await source('plots/plot-factory.js');
  const base = await source('plots/plot-base.js');

  const lifecycleUpdate = between(
    lifecycle,
    'export async function renderOrUpdatePlot',
    '\n}',
  );
  assert.doesNotMatch(lifecycleUpdate, /catch\s*\(/);
  assert.doesNotMatch(lifecycleUpdate, /fall\s*back|fallback/i);

  const factoryUpdate = between(
    factory,
    'static async update',
    '// ===========================================================================\n  // TRACE BUILDING HELPERS',
  );
  assert.doesNotMatch(factoryUpdate, /catch\s*\(/);
  assert.doesNotMatch(factoryUpdate, /fall\s*back|fallback/i);

  const baseUpdate = between(
    base,
    'static async updatePlot',
    '// ===========================================================================\n  // Instance Methods',
  );
  assert.doesNotMatch(baseUpdate, /catch\s*\(/);
  assert.doesNotMatch(baseUpdate, /renderFallback|fall\s*back|fallback/i);
  assert.doesNotMatch(base, /default implementation re-renders|provide fallback to render/i);
});

test('analysis public utilities expose no retry or failure-to-null operation', async () => {
  const errors = await source('shared/error-utils.js');
  const index = await source('shared/index.js');

  assert.doesNotMatch(errors, /export async function retry\b/);
  assert.doesNotMatch(errors, /export async function tryAsync\b/);
  assert.doesNotMatch(errors, /\btryAsync\b|\bretry\b/);
  assert.doesNotMatch(index, /\btryAsync\b|\bretry\b/);
});
