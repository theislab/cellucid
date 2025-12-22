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
import { FieldOverlayPublicMethods } from './field/overlay-public.js';
import { FieldOverlayInternalMethods } from './field/overlay-internals.js';
import { FieldCategoryOpsMethods } from './field/category-ops.js';
import { FieldLoadingMethods } from './field/loading.js';
import { FieldSummaryMethods } from './field/summary.js';

function applyMixin(targetProto, mixinProto) {
  const descriptors = Object.getOwnPropertyDescriptors(mixinProto);
  delete descriptors.constructor;
  Object.defineProperties(targetProto, descriptors);
}

export class DataStateFieldMethods {}

applyMixin(DataStateFieldMethods.prototype, FieldOverlayInternalMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldOverlayPublicMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldCategoryOpsMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldLoadingMethods.prototype);
applyMixin(DataStateFieldMethods.prototype, FieldSummaryMethods.prototype);

export class FieldManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
