import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const MAINTAINER_REFERENCE_URL = new URL(
  '../assets/js/app/session/README.md',
  import.meta.url,
);
const INVENTORY_REFERENCE_URL = new URL(
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
    'CELLUCID_SESSION/4',
    'history-file.js',
    'values/<priority>/<k>',
    'parts/<priority>/<k>',
    'chat/<n>/<m>',
    'journal/<n>',
    'Bounded pieces',
    'Compression, per chunk by measured gain',
    'a value, an array or a part no step refers to and a step referring to a value the file lacks are rejected',
    'one tracker of one root',
    'A session file holds domain values as they are, with no encoder of its own per feature',
    'the complete restore rejects and rolls back',
    'no dataset-agnostic layout subset is salvaged',
    'a session file holds domain values',
    'do not add a reader for an older shape',
  ]) {
    assert.match(normalized, new RegExp(
      exact.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    ));
  }

  // The control inventory's reference states which controls it deliberately
  // leaves out. That claim went stale once already — `pointer-lock` sat in
  // DOMAIN_OWNED_IDS with no entry there, so a reader checking why the pointer
  // capture box does not come back found nothing. Derive the set rather than
  // restating it, so the next id added there has to be explained there too.
  const inventory = (await readFile(INVENTORY_REFERENCE_URL, 'utf8')).replaceAll(/\s+/g, ' ').trim();
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
    id => !inventory.includes(`\`${id}\``),
  );
  assert.deepEqual(
    undocumented,
    [],
    'every id the control inventory leaves out must be named in its '
      + 'reference with the reason it is left out; a silent exclusion '
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
    // Session format 3: one state in per-feature chunks.
    'CELLUCID_SESSION/3\\n',
    'contributor',
    'restore transaction',
    'Exactly one codes chunk is required',
    'membership chunk per advertised group',
    'seven static chunks',
    'PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE',
    'Session Bundle Coverage',
    'participant of the restore transaction whose rollback restores the previous',
    // Session format 1.
    'analysis/cache-inventory',
    'bulk-gene',
    'carries no version field',
    'five-chunk',
  ]) {
    assert.doesNotMatch(normalized, new RegExp(
      retired.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    ));
  }
});
