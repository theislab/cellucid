/**
 * A method group mixed onto a class: every member of `mixinProto` (methods,
 * getters and setters, by their descriptors) defined on `targetProto`, as
 * if written in the class body, the group's `constructor` left out. By
 * descriptor, never `Object.assign`, which would run a getter instead of
 * copying it. `DataState` (`app/state/core/data-state.js`), the field
 * manager's groups and `AnnDataReader` (`data/anndata/reader.js`) are made
 * this way; how a group is typed is `types/mixins.d.ts`.
 *
 * @module utils/apply-mixin
 */

/**
 * @param {object} targetProto - The prototype the members go on
 * @param {object} mixinProto - The group's prototype
 */
export function applyMixin(targetProto, mixinProto) {
  const descriptors = Object.getOwnPropertyDescriptors(mixinProto);
  delete descriptors.constructor;
  Object.defineProperties(targetProto, descriptors);
}
