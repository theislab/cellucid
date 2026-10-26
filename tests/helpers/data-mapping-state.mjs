/**
 * Give a hand-built DataState stand-in the real data-mapping methods of
 * `app/state/managers/mapping-manager.js`, over the given mapping, so session
 * and UI tests exercise the same refusal and apply rules the app runs.
 */
import { DataStateMappingMethods } from '../../assets/js/app/state/managers/mapping-manager.js';
import { DataStateMappingGroupMethods } from '../../assets/js/app/state/managers/mapping-groups.js';
import { DataStateVarAxisMethods } from '../../assets/js/app/state/managers/var-axis.js';
import { DataStateLatentSpaceMethods } from '../../assets/js/app/state/managers/latent-space.js';

/**
 * @param {object} state - Must carry `dimensionManager`.
 * @param {{mapping: object|null, candidates?: object|null, origin?: string|null}} options
 * @returns {object} The same state.
 */
export function installDataMappingMethods(
  state,
  { mapping, candidates = null, origin = 'default' }
) {
  for (const methods of [
    DataStateMappingMethods,
    DataStateMappingGroupMethods,
    DataStateVarAxisMethods,
    DataStateLatentSpaceMethods,
  ]) {
    const descriptors = Object.getOwnPropertyDescriptors(methods.prototype);
    delete descriptors.constructor;
    Object.defineProperties(state, descriptors);
  }
  state.dataMapping = mapping;
  state._mappingCandidates = candidates;
  state._mappingOrigin = mapping === null ? null : origin;
  state._mappingPublicationOrigin = state._mappingOrigin;
  state._unusableEmbeddings = new Map();
  // What publishing a dataset's mapping sets up for its groups.
  state._resetMappingGroups();
  state._mappingRuntime = null;
  state._mappingChangeLock = null;
  if (typeof state.emit !== 'function') state.emit = () => {};
  // DataState's dataset generation (`field/loading.js`), which a mapping
  // transaction belongs to; a test publishes another dataset by advancing it.
  if (typeof state.getDatasetGeneration !== 'function') {
    state._datasetGeneration ??= 0;
    state.getDatasetGeneration = function getDatasetGeneration() {
      return this._datasetGeneration;
    };
  }
  return state;
}
