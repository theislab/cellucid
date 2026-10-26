import assert from 'node:assert/strict';
import test from 'node:test';

import { RenameRegistry } from '../assets/js/app/registries/rename-registry.js';
import { DeleteRegistry } from '../assets/js/app/registries/delete-registry.js';
import {
  FieldOverlayInternalMethods,
  carryOverlayRevisions,
} from '../assets/js/app/state/managers/field/overlay-internals.js';
import { FieldSource } from '../assets/js/app/utils/field-constants.js';
import { getFieldRegistry } from '../assets/js/app/utils/field-registry.js';

/**
 * Field overlays (renames, deletions) are applied to an inventory once in
 * full, and afterwards only to the fields edited since: a view switch or a
 * kept view over 8,192 genes reads the edits, not every gene.
 */
function createOverlayOwner(geneCount) {
  const renames = new RenameRegistry();
  const deletions = new DeleteRegistry();
  const reads = { displayKey: 0 };
  const getDisplayKey = renames.getDisplayKey.bind(renames);
  renames.getDisplayKey = (source, key) => {
    reads.displayKey += 1;
    return getDisplayKey(source, key);
  };
  const owner = Object.assign(Object.create(FieldOverlayInternalMethods.prototype), {
    _renameRegistry: renames,
    _deleteRegistry: deletions,
    _syncCentroidCategoryLabels() {},
    obsData: { fields: [] },
    varData: {
      fields: Array.from({ length: geneCount }, (_, index) => ({
        key: `G${index}`,
        kind: 'continuous',
      })),
    },
  });
  getFieldRegistry().bind(owner);
  return { owner, renames, deletions, reads };
}

test('an inventory reads only the fields edited since it last showed the registries', () => {
  const { owner, renames, deletions, reads } = createOverlayOwner(8192);
  const genes = owner.varData.fields;

  // First application, nothing edited: no gene is looked up.
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(reads.displayKey, 0);

  // Again, nothing edited: nothing is read.
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(reads.displayKey, 0);

  // A copy (a kept view's inventory) shows what its source showed.
  const kept = genes.map(field => ({ ...field }));
  carryOverlayRevisions(genes, kept);

  // One rename and one deletion: each inventory reads those two genes.
  renames.setFieldRename(FieldSource.VAR, 'G10', 'renamed');
  deletions.markDeleted(FieldSource.VAR, 'G20');
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(reads.displayKey, 2);
  assert.equal(genes[10].key, 'renamed');
  assert.equal(genes[10]._originalKey, 'G10');
  assert.equal(genes[20]._isDeleted, true);
  owner._applyOverlaysToFields(kept, FieldSource.VAR);
  assert.equal(reads.displayKey, 4);
  assert.equal(kept[10].key, 'renamed');
  assert.equal(kept[20]._isDeleted, true);

  // An obs edit is not a gene's.
  renames.setFieldRename(FieldSource.OBS, 'G30', 'obs-only');
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(reads.displayKey, 4);
  assert.equal(genes[30].key, 'G30');

  // Reverting reads the reverted gene and shows its own name again.
  renames.revertFieldRename(FieldSource.VAR, 'G10');
  deletions.markRestored(FieldSource.VAR, 'G20');
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(genes[10].key, 'G10');
  assert.equal(Object.hasOwn(genes[10], '_originalKey'), false);
  assert.equal(Object.hasOwn(genes[20], '_isDeleted'), false);
});

test('a replaced registry is read again in full', () => {
  const { owner, renames, deletions } = createOverlayOwner(64);
  const genes = owner.varData.fields;
  renames.setFieldRename(FieldSource.VAR, 'G1', 'one');
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(genes[1].key, 'one');

  // A session restore replaces both registries: every gene is shown anew.
  renames.fromJSON({ fields: { 'var:G2': 'two' }, categories: {} });
  deletions.fromJSON({ deleted: ['var:G3'], purged: [] });
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(genes[1].key, 'G1');
  assert.equal(genes[2].key, 'two');
  assert.equal(genes[3]._isDeleted, true);

  // Clearing them shows every gene under its own name.
  renames.clear();
  deletions.clear();
  owner._applyOverlaysToFields(genes, FieldSource.VAR);
  assert.equal(genes[2].key, 'G2');
  assert.equal(Object.hasOwn(genes[3], '_isDeleted'), false);
});

test('registries record each edit and start over on replacement', () => {
  const renames = new RenameRegistry();
  const start = renames.getRevision();
  renames.setFieldRename(FieldSource.OBS, 'a', 'b');
  renames.setCategoryRename(FieldSource.OBS, 'c', 'x', 'y');
  assert.deepEqual(
    renames.editsSince(start).map(({ source, originalKey }) => [source, originalKey]),
    [[FieldSource.OBS, 'a'], [FieldSource.OBS, 'c']],
  );
  assert.deepEqual(renames.editsSince(renames.getRevision()), []);
  renames.clear();
  assert.equal(renames.editsSince(start), null);
  assert.deepEqual(renames.editsSince(renames.getRevision()), []);
  assert.equal(renames.hasEntriesFor(FieldSource.OBS), false);
  renames.setFieldRename(FieldSource.VAR, 'g', 'h');
  assert.equal(renames.hasEntriesFor(FieldSource.VAR), true);
  assert.equal(renames.hasEntriesFor(FieldSource.OBS), false);
});
