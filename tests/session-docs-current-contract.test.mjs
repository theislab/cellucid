import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const MAINTAINER_REFERENCE_URL = new URL(
  '../assets/js/app/state-serializer/README.md',
  import.meta.url,
);
const UI_CONTROLS_URL = new URL(
  '../assets/js/app/state-serializer/ui-controls.js',
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

  // The reference states which controls the generic contributor deliberately
  // does not carry. That claim went stale once already — `pointer-lock` sat in
  // DOMAIN_OWNED_IDS with no entry here, so a reader checking why the pointer
  // capture box does not come back found nothing. Derive the set rather than
  // restating it, so the next id added there has to be explained here too.
  const uiControlsSource = await readFile(UI_CONTROLS_URL, 'utf8');
  const domainOwnedBlock = /const DOMAIN_OWNED_IDS = new Set\(\[([\s\S]*?)\]\)/
    .exec(uiControlsSource);
  assert.ok(
    domainOwnedBlock !== null,
    'ui-controls.js must still declare DOMAIN_OWNED_IDS as a Set literal, or '
      + 'this check is silently reading nothing',
  );
  const domainOwnedIds = [...domainOwnedBlock[1].matchAll(/'([^']+)'/g)]
    .map(match => match[1]);
  assert.ok(
    domainOwnedIds.length > 0,
    'DOMAIN_OWNED_IDS must be non-empty, or the loop below is vacuous',
  );
  const undocumented = domainOwnedIds.filter(
    id => !normalized.includes(`\`${id}\``),
  );
  assert.deepEqual(
    undocumented,
    [],
    'every id the generic UI contributor skips must be named in the '
      + 'maintainer reference with the reason it is skipped; a silent exclusion '
      + 'is indistinguishable from a control that was forgotten',
  );

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
