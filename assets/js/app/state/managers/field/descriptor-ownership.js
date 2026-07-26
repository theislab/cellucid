/**
 * @fileoverview Ownership boundary for immutable scientific field descriptors.
 *
 * Manifest field descriptors are exact scientific input contracts. DataState
 * fields are mutable runtime records that acquire payloads and UI bookkeeping.
 * These two objects must never be the same object.
 */

function cloneAndFreezeDescriptorValue(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeDescriptorValue));
  }

  if (value !== null && typeof value === 'object') {
    const clone = {};
    for (const key of Object.keys(value)) {
      clone[key] = cloneAndFreezeDescriptorValue(value[key]);
    }
    return Object.freeze(clone);
  }

  return value;
}

/**
 * Capture the exact unloaded descriptors before DataState adds runtime keys.
 *
 * Every enumerable descriptor property is retained. Nothing is selected,
 * removed, renamed, normalized, or synthesized. A field that already owns an
 * eager values/codes payload is runtime data and has no lazy-load descriptor.
 *
 * @param {object[]} fields
 * @returns {ReadonlyArray<object|null>}
 */
export function adoptScientificFieldDescriptors(fields) {
  const descriptors = fields.map((field) => {
    if (field?.values || field?.codes) return null;
    return cloneAndFreezeDescriptorValue(field);
  });
  return Object.freeze(descriptors);
}
