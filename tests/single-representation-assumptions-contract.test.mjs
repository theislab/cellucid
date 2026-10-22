// A dataset can show any number of representations of each dimension, and a
// view shows exactly one of them; its dimension is derived from it. This
// sweep fails on any leftover of the model in which a dimension named one
// embedding: a stored per-view dimension or override, slot setters, a
// dimension-keyed event, a dimension select, or code that turns a dimension
// back into "the" embedding of that dimension.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = await sources(path.join(ROOT, 'assets', 'js'));
// Keyed by the repository path with `/` on every platform, as the paths this
// file names are written; on Windows `path.relative` joins with `\`, and the
// lookups below found nothing.
const CODE = new Map(await Promise.all(FILES.map(async file => [
  path.relative(ROOT, file).split(path.sep).join('/'),
  await readFile(file, 'utf8'),
])));
const HTML = await readFile(path.join(ROOT, 'index.html'), 'utf8');

function hits(pattern, { allow = [] } = {}) {
  const found = [];
  for (const [file, text] of CODE) {
    if (allow.includes(file)) continue;
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('no view stores a dimension or an embedding override beside its representation', () => {
  assert.deepEqual(hits(/embeddingOverride|EmbeddingOverride/), []);
  assert.deepEqual(hits(/activeDimensionLevel|liveDimensionLevel/), []);
  // View contexts (DataState) hold no dimension; a render-time overlay
  // context carries the dimension of the representation it draws.
  assert.deepEqual(hits(/\b(?:context|prevCtx)\.dimensionLevel\b/), []);
});

test('no slot setter or slot resolution survives: defaults are a property of the enabled set', () => {
  assert.deepEqual(hits(/\b(?:getSlotLayout|setSlotLayout|clearSlotLayout|resolveViewLayout|_slotLayouts)\b/), []);
  assert.deepEqual(hits(/\bsetDimensionLevel\b/), []);
  assert.deepEqual(hits(/\b(?:getEmbeddingChoices|countViewsFollowingSlots)\b/), []);
});

test('representation changes are announced per view, not as a dimension change', () => {
  assert.deepEqual(hits(/['"]dimension:changed['"]/), []);
  assert.doesNotMatch(HTML, /id="dimension-select"|id="view-embedding-select"|id="dimension-controls"/);
});

test('no code turns a dimension back into "the" embedding of that dimension', () => {
  // A mapping's embeddings are {enabled, defaults}; only the defaults are
  // keyed by dimension, and only the mapping rules and the dataset identity
  // read them that way.
  const allow = [
    'assets/js/data/data-mapping.js',
    'assets/js/data/dataset-mapping.js',
    'assets/js/data/data-mapping-candidates.js',
    'assets/js/data/base-anndata-adapter.js',
    'assets/js/data/dimension-manager.js',
    'assets/js/data/dataset-identity.js',
    'assets/js/app/state/managers/mapping-manager.js',
    'assets/js/app/ui/modules/data-mapping-controls.js',
    'assets/js/analytics/schema.js',
  ];
  assert.deepEqual(
    hits(/embeddings(?:\.defaults)?\[`\$\{[^}]+\}d`\]|embeddings\[['"][123]d['"]\]/, { allow }),
    []
  );
  // The old shape indexed the mapping's embeddings by slot directly.
  assert.deepEqual(hits(/\.embeddings\[slot\]|embeddings\[`\$\{dimension\}d`\]/, { allow: [
    'assets/js/data/dimension-manager.js',
  ] }), []);
});

test('the renderer shares geometry by representation, never by dimension alone', () => {
  const renderer = CODE.get('assets/js/rendering/high-perf-renderer.js');
  // Snapshot geometry is looked up by its positions array (one per
  // representation), so two views of two embeddings of one dimension never
  // share a buffer or a tree, and two views of one embedding always do.
  assert.match(renderer, /_findPooledGeometry\(positions, dimension\)/);
  assert.match(renderer, /geometry\.positions === positions && geometry\.dimension === dimension/);
  // The per-dimension maps belong to the one live publication (one geometry)
  // and are replaced with it; nothing else keys a cache by dimension.
  // (The registry's defaults are keyed by dimension by definition.)
  const dimensionMaps = hits(/new Map\(\[\[\s*(?:dim|dimension|newDimLevel|dimensionLevel)\b/, {
    allow: ['assets/js/data/dimension-manager.js'],
  }).filter(line => !line.startsWith('assets/js/rendering/high-perf-renderer.js'));
  assert.deepEqual(dimensionMaps, []);
});
