/**
 * @fileoverview The demo-export fixture must still be the demo repository's
 * exports.
 *
 * `tests/browser/fixtures/demo-custom-exports/` is a byte-for-byte copy of
 * `cellucid-demo-custom-datasets/exports/`, and six browser specs load a
 * dataset from it to exercise the local-prepared, GitHub and failure paths.
 * The copy is what makes those specs runnable without the sibling checkout.
 *
 * Nothing tied the two together. The demo repository regenerates its exports
 * from `generate_datasets.py`, so a regeneration - or a change to the writer
 * that produces them - moves the originals and leaves the copy behind, and
 * every spec keeps passing against data the project no longer publishes. That
 * is the same shape as a stale export passing its own tests, which is the
 * defect this project has already been bitten by once.
 *
 * The comparison runs when the sibling repository is checked out beside this
 * one and reports itself skipped when it is not, matching how the categorical
 * storage contract compares against the two writers.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const FIXTURE_URL = new URL(
  '../tests/browser/fixtures/demo-custom-exports/',
  import.meta.url
);
const SOURCE_URL = new URL(
  '../../cellucid-demo-custom-datasets/exports/',
  import.meta.url
);

async function collectFiles(root) {
  const files = new Map();

  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    for (const entry of entries) {
      const child = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        directory
      );
      if (entry.isDirectory()) {
        await walk(child, `${prefix}${entry.name}/`);
        continue;
      }
      const bytes = await readFile(child);
      files.set(
        `${prefix}${entry.name}`,
        createHash('sha256').update(bytes).digest('hex')
      );
    }
    return files;
  }

  return walk(root, '');
}

test('the browser fixture is exactly the demo repository exports', async (t) => {
  const source = await collectFiles(SOURCE_URL);
  if (source === null) {
    t.skip(
      'cellucid-demo-custom-datasets is not checked out beside this repository'
    );
    return;
  }

  const fixture = await collectFiles(FIXTURE_URL);
  assert.notEqual(
    fixture,
    null,
    'the fixture directory must exist; six browser specs load datasets from it'
  );

  const sourcePaths = [...source.keys()].sort();
  const fixturePaths = [...fixture.keys()].sort();
  assert.deepEqual(
    fixturePaths,
    sourcePaths,
    'the fixture must hold exactly the files the demo repository publishes; '
      + 'regenerate it from cellucid-demo-custom-datasets/exports/'
  );

  const differing = sourcePaths.filter(
    path => fixture.get(path) !== source.get(path)
  );
  assert.deepEqual(
    differing,
    [],
    'the fixture bytes must equal the published bytes; the demo exports were '
      + 'regenerated without refreshing this copy'
  );

  assert.ok(
    sourcePaths.length > 0,
    'an empty comparison would pass while proving nothing'
  );
});
