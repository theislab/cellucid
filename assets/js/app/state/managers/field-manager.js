/**
 * @fileoverview Field manager mixin assembly.
 *
 * Field-related DataState methods are implemented as a set of focused mixins
 * under `./field/`. This file assembles those mixins into the single
 * `DataStateFieldMethods` prototype that gets applied to `DataState`.
 *
 * @module state/managers/field-manager
 */

import { BaseManager } from '../core/base-manager.js';
import { applyMixin } from '../../../utils/apply-mixin.js';
import { FieldOverlayPublicMethods } from './field/overlay-public.js';
import { FieldOverlayInternalMethods } from './field/overlay-internals.js';
import { FieldCategoryOpsMethods } from './field/category-ops.js';
import { FieldLoadingMethods } from './field/loading.js';
import { FieldSummaryMethods } from './field/summary.js';
import { FieldGeneSampleMethods } from './field/gene-sample.js';

export class DataStateFieldMethods {}

applyMixin(DataStateFieldMethods.prototype, FieldOverlayInternalMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldOverlayPublicMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldCategoryOpsMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldLoadingMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldSummaryMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldGeneSampleMethods.prototype);

export class FieldManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
