import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const MAINTAINER_REFERENCE_URL = new URL(
  '../assets/js/app/state-serializer/README.md',
  import.meta.url,
);

test('session maintainer reference describes only the atomic current format', async () => {
  const source = await readFile(MAINTAINER_REFERENCE_URL, 'utf8');
  const normalized = source.replaceAll(/\s+/g, ' ').trim();

  for (const exact of [
    'one current state document',
    'one awaited public operation',
    'analysis/cache-inventory',
    'cinematic/camera',
    'Exactly one codes chunk is required for every categorical overlay field',
    'one compact binary membership chunk per advertised group',
    'the complete restore rejects and rolls back',
    'no dataset-agnostic layout subset is salvaged',
    'not accepted by generic **Load State**',
    'do not add a reader for an older shape',
  ]) {
    assert.match(normalized, new RegExp(
      exact.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    ));
  }

  for (const retired of [
    'heavier artifacts converge in the background',
    'dataset-dependent chunks are skipped',
    'dataset-agnostic layout (floating panels) can still restore',
    'memberships fill in progressively',
    'pages/groups appear immediately',
    'dev-phase',
    'Recommended Additions',
  ]) {
    assert.doesNotMatch(normalized, new RegExp(
      retired.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    ));
  }
});
