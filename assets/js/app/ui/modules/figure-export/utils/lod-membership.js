/**
 * @fileoverview Exact LOD-membership contract for figure export.
 *
 * Figure export consumes the renderer's immutable admitted-index prefix
 * directly. This avoids allocating a dense per-view visibility array and lets
 * sequential export work scale with the K rendered points rather than all N
 * source points. The admission-level owner remains available to random-access
 * consumers.
 *
 * `null` is the canonical full-detail value. For a descriptor, source point
 * `index` is admitted exactly when:
 *
 *   admissionLevels[index] <= lodLevel
 *
 * `indices` contains exactly those admitted source IDs in renderer draw order.
 *
 * @module ui/modules/figure-export/utils/lod-membership
 */

const EXACT_RENDERER_DESCRIPTOR_KEYS =
  'admissionLevels,dimensionLevel,generationToken,indices,lodLevel,pointCount';
const EXACT_EXPORT_DESCRIPTOR_KEYS =
  'dimensionLevel,generationToken,indices,lodLevel,pointCount';

export {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../../../../../rendering/alpha-visibility.js';

/**
 * @typedef {Readonly<{
 *   admissionLevels?: Uint8Array;
 *   dimensionLevel: number;
 *   generationToken: unknown;
 *   indices: Uint32Array;
 *   lodLevel: number;
 *   pointCount: number;
 * }>} LodMembership
 */

/**
 * Validate and return an immutable LOD membership descriptor.
 *
 * This is intentionally a boundary check rather than a per-point helper. Hot
 * loops cache `indices` after this function returns. Renderer descriptors also
 * own the dense random-access admission levels used by interactive selection.
 * Atomic export snapshots may omit that N-byte array because every sequential
 * export path consumes only the exact admitted `indices` prefix.
 *
 * @param {LodMembership|null} membership
 * @param {object} [expected]
 * @param {number|null} [expected.pointCount]
 * @param {number|null} [expected.dimensionLevel]
 * @param {string} [expected.label]
 * @returns {LodMembership|null}
 */
export function assertLodMembership(
  membership,
  {
    pointCount = null,
    dimensionLevel = null,
    label = 'Figure-export LOD membership',
  } = {}
) {
  if (membership === null) return null;
  const ownKeys =
    typeof membership === 'object' && membership !== null
      ? Reflect.ownKeys(membership)
      : [];
  const exactKeyString = ownKeys
    .filter((key) => typeof key === 'string')
    .sort()
    .join(',');
  const hasRendererAdmissionOwner =
    exactKeyString === EXACT_RENDERER_DESCRIPTOR_KEYS;
  const hasCompactExportOwner =
    exactKeyString === EXACT_EXPORT_DESCRIPTOR_KEYS;
  if (
    typeof membership !== 'object' ||
    Array.isArray(membership) ||
    Object.getPrototypeOf(membership) !== Object.prototype ||
    ownKeys.some((key) => typeof key !== 'string') ||
    (!hasRendererAdmissionOwner && !hasCompactExportOwner) ||
    !Object.isFrozen(membership)
  ) {
    throw new TypeError(`${label} must be null or an exact frozen descriptor.`);
  }

  if (
    !(membership.indices instanceof Uint32Array) ||
    !Number.isSafeInteger(membership.pointCount) ||
    membership.pointCount < 0 ||
    membership.indices.length > membership.pointCount
  ) {
    throw new TypeError(
      `${label} must own one exact admitted Uint32 prefix.`
    );
  }
  if (
    hasRendererAdmissionOwner &&
    (
      !(membership.admissionLevels instanceof Uint8Array) ||
      membership.admissionLevels.length !== membership.pointCount
    )
  ) {
    throw new TypeError(
      `${label} renderer descriptor must own one Uint8 admission level per source point.`
    );
  }
  if (
    !Number.isInteger(membership.dimensionLevel) ||
    membership.dimensionLevel < 1 ||
    membership.dimensionLevel > 3
  ) {
    throw new RangeError(`${label}.dimensionLevel must be 1, 2, or 3.`);
  }
  if (
    !Number.isInteger(membership.lodLevel) ||
    membership.lodLevel < 0 ||
    membership.lodLevel >= 0xff
  ) {
    throw new RangeError(
      `${label}.lodLevel must be an integer in [0, 254].`
    );
  }
  if (
    membership.generationToken === null ||
    typeof membership.generationToken !== 'object' ||
    !Object.isFrozen(membership.generationToken)
  ) {
    throw new TypeError(
      `${label}.generationToken must be one frozen opaque object.`
    );
  }
  if (
    pointCount !== null &&
    (!Number.isSafeInteger(pointCount) ||
      pointCount < 0 ||
      membership.pointCount !== pointCount)
  ) {
    throw new RangeError(`${label}.pointCount does not match the exported positions.`);
  }
  if (
    dimensionLevel !== null &&
    (!Number.isInteger(dimensionLevel) ||
      dimensionLevel < 1 ||
      dimensionLevel > 3 ||
      membership.dimensionLevel !== dimensionLevel)
  ) {
    throw new RangeError(
      `${label}.dimensionLevel does not match the exported view.`
    );
  }

  return membership;
}

/**
 * Compare one lightweight presented LOD certificate with the exact borrowed
 * renderer membership without exposing either admitted-index owner.
 *
 * @param {object|null} presented
 * @param {LodMembership|null} membership
 * @returns {boolean}
 */
export function matchesLodMembershipPresentation(
  presented,
  membership
) {
  if (presented === null || membership === null) {
    return presented === null && membership === null;
  }
  return (
    typeof presented === 'object' &&
    !Array.isArray(presented) &&
    Object.isFrozen(presented) &&
    Reflect.ownKeys(presented).length === 5 &&
    Number.isSafeInteger(presented.admittedCount) &&
    presented.admittedCount === membership.indices?.length &&
    presented.dimensionLevel === membership.dimensionLevel &&
    presented.generationToken === membership.generationToken &&
    presented.lodLevel === membership.lodLevel &&
    presented.pointCount === membership.pointCount
  );
}
