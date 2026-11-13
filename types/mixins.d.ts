/**
 * The method groups mixed onto a class's prototype (`utils/apply-mixin.js`),
 * declared on the class they are mixed onto, so the type check sees the
 * owner's members wherever they are used: one `interface Owner extends Group`
 * a group, in the owner module's declaration. Inside a group each member says
 * whose `this` it runs with, the first tag of its JSDoc (`@this`). A group
 * that is an object of methods (a bag) is named by its type. No page or
 * bundle loads this file.
 */

import type { DataStateViewMethods } from '../assets/js/app/state/managers/view-manager.js';
import type { DataStateMappingMethods } from '../assets/js/app/state/managers/mapping-manager.js';
import type { DataStateMappingGroupMethods } from '../assets/js/app/state/managers/mapping-groups.js';
import type { DataStateVarAxisMethods } from '../assets/js/app/state/managers/var-axis.js';
import type { DataStateLatentSpaceMethods } from '../assets/js/app/state/managers/latent-space.js';
import type { DataStateOutlierQuantileMethods } from '../assets/js/app/state/managers/outlier-quantiles.js';
import type { DataStateOpenCellsMethods } from '../assets/js/app/state/managers/open-cells.js';
import type { DataStateExpressionMethods } from '../assets/js/app/state/managers/expression-values.js';
import type { DataStateFieldMethods } from '../assets/js/app/state/managers/field-manager.js';
import type { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import type { DataStateFilterMethods } from '../assets/js/app/state/managers/filter-manager.js';
import type { highlightStateMethods } from '../assets/js/app/state/managers/highlight-manager.js';
import type { highlightAccessorMethods } from '../assets/js/app/state/managers/highlight-accessors.js';
import type { colorOutlierMethods } from '../assets/js/app/state/managers/color-outliers.js';
import type { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';
import type { viewContextViewerSyncMethods } from '../assets/js/app/state/managers/view-context-viewer-sync.js';
import type { FieldOverlayInternalMethods } from '../assets/js/app/state/managers/field/overlay-internals.js';
import type { FieldOverlayPublicMethods } from '../assets/js/app/state/managers/field/overlay-public.js';
import type { FieldCategoryOpsMethods } from '../assets/js/app/state/managers/field/category-ops.js';
import type { FieldLoadingMethods } from '../assets/js/app/state/managers/field/loading.js';
import type { FieldSummaryMethods } from '../assets/js/app/state/managers/field/summary.js';
import type { FieldGeneSampleMethods } from '../assets/js/app/state/managers/field/gene-sample.js';
import type { AnnDataReaderStoredOutlierMethods } from '../assets/js/data/anndata/reader/stored-outliers.js';
import type { AnnDataReaderNameMethods } from '../assets/js/data/anndata/reader/names.js';
import type { AnnDataReaderObsmMethods } from '../assets/js/data/anndata/reader/obsm.js';
import type { AnnDataReaderFieldMethods } from '../assets/js/data/anndata/reader/fields.js';
import type { AnnDataReaderGraphMethods } from '../assets/js/data/anndata/reader/graphs.js';
import type { AnnDataReaderMappingProbeMethods } from '../assets/js/data/anndata/reader/mapping-probe.js';
import type { AnnDataReaderMatrixRowMethods } from '../assets/js/data/anndata/reader/matrix-rows.js';
import type { AnnDataReaderGeneColumnMethods } from '../assets/js/data/anndata/reader/gene-columns.js';
import type { AnnDataReaderCellSubsetMethods } from '../assets/js/data/anndata/reader/cell-subset-reads.js';
import type { AnnDataReaderGeneSampleMethods } from '../assets/js/data/anndata/reader/gene-sample.js';
import type { AnnDataReaderKeptIndexMethods } from '../assets/js/data/anndata/reader/kept-indexes.js';
import type { AnnDataReaderRowPointerMethods } from '../assets/js/data/anndata/reader/row-pointers.js';
import type { AnnDataReaderMatrixMethods } from '../assets/js/data/anndata/reader/matrices.js';
import type { AnnDataReaderGeneSegmentMethods } from '../assets/js/data/anndata/reader/gene-segments.js';

type HighlightStateMethods = typeof highlightStateMethods;
type HighlightAccessorMethods = typeof highlightAccessorMethods;
type ColorOutlierMethods = typeof colorOutlierMethods;
type ViewContextCoreMethods = typeof viewContextCoreMethods;
type ViewContextViewerSyncMethods = typeof viewContextViewerSyncMethods;

// `data-state.js`: its groups, and the highlight bag (the accessors merged in).
declare module '../assets/js/app/state/core/data-state.js' {
  interface DataState extends DataStateViewMethods, DataStateMappingMethods, DataStateMappingGroupMethods,
    DataStateVarAxisMethods, DataStateLatentSpaceMethods, DataStateOutlierQuantileMethods, DataStateOpenCellsMethods,
    DataStateExpressionMethods, DataStateFieldMethods, DataStateColorMethods, DataStateFilterMethods,
    HighlightStateMethods, HighlightAccessorMethods {}
}

// `field-manager.js`: the field groups of `field/`.
declare module '../assets/js/app/state/managers/field-manager.js' {
  interface DataStateFieldMethods extends FieldOverlayInternalMethods, FieldOverlayPublicMethods, FieldCategoryOpsMethods,
    FieldLoadingMethods, FieldSummaryMethods, FieldGeneSampleMethods {}
}

// `view-manager.js` and `color-manager.js`: the bags assigned onto their groups.
declare module '../assets/js/app/state/managers/view-manager.js' {
  interface DataStateViewMethods extends ViewContextCoreMethods, ViewContextViewerSyncMethods {}
}
declare module '../assets/js/app/state/managers/color-manager.js' {
  interface DataStateColorMethods extends ColorOutlierMethods {}
}

// `reader.js`: the reader's method groups (`data/anndata/reader/`).
declare module '../assets/js/data/anndata/reader.js' {
  interface AnnDataReader extends AnnDataReaderStoredOutlierMethods, AnnDataReaderNameMethods,
    AnnDataReaderObsmMethods, AnnDataReaderFieldMethods, AnnDataReaderGraphMethods, AnnDataReaderMappingProbeMethods,
    AnnDataReaderMatrixRowMethods, AnnDataReaderGeneColumnMethods, AnnDataReaderCellSubsetMethods,
    AnnDataReaderGeneSampleMethods, AnnDataReaderKeptIndexMethods, AnnDataReaderRowPointerMethods,
    AnnDataReaderMatrixMethods, AnnDataReaderGeneSegmentMethods {}
}
