/**
 * h5Seurat (SeuratDisk's own HDF5 layout of a Seurat object): recognised and
 * refused with what to do (design decision D11: SeuratDisk is unmaintained
 * since 2023, and an `.rds` of the same object opens directly).
 *
 * An h5Seurat root holds `assays`, `cell.names`, `meta.data` and
 * `reductions` groups, with `active.assay`, `project` and `version`
 * attributes. (`Convert()` output is an `.h5ad`, read as AnnData by
 * `older-layouts.js`.)
 *
 * @module data/anndata/views/h5seurat
 */

import { isGroup } from '../../../formats/store.js';
import { H5AD_FORMAT } from '../elements.js';
import { LayoutRefusal } from './refusal.js';
import { inputFormat } from '../../input-formats.js';

export const H5SEURAT_VIEW = Object.freeze({
  recognize: root => isGroup(root) && root.has('cell.names') && isGroup(root.get('assays')),
  view() {
    // The registry's words, which cellucid serve and cellucid_serve() use too.
    throw new LayoutRefusal(inputFormat('h5seurat').refusal, { reason: 'h5seurat' });
  },
  readerFormat: H5AD_FORMAT,
});
