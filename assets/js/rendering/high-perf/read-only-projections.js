/**
 * Read-only projections of renderer-owned CPU state.
 *
 * Lazily exposes a spatial generation or a LOD buffer list without handing the
 * caller the accepted mutable graph. Typed arrays are copied only when actually
 * observed. Holds no reference to SpatialIndex or HighPerfRenderer -- it
 * projects whatever object it is handed.
 */

const EMPTY_LOD_PROJECTION = Object.freeze([]);
const READ_ONLY_LOD_PROJECTIONS = new WeakMap();
const READ_ONLY_SPATIAL_PROJECTIONS = new WeakMap();
const READ_ONLY_SPATIAL_METHODS = new WeakMap();
const READ_ONLY_MUTATOR_METHODS = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'ensureLODLevels',
  'ensureLodNodeMappings',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const SPATIAL_PRIMITIVE_VISITOR_METHODS = new Set([
  'visitProjectedRectCandidates',
  'visitRadiusCandidates',
  'visitRaySegmentCandidates',
]);
/**
 * Lazily expose a CPU spatial generation without handing callers its accepted
 * mutable graph. Typed arrays are copied only when actually observed; query
 * methods still execute against the exact renderer owner and recursively
 * project every callback/result.
 */
function getReadOnlySpatialProjection(value, owner = 'SpatialIndex') {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    let copy = READ_ONLY_SPATIAL_PROJECTIONS.get(value);
    if (copy === undefined) {
      copy = value instanceof DataView
        ? new DataView(value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        ))
        : new value.constructor(value);
      READ_ONLY_SPATIAL_PROJECTIONS.set(value, copy);
    }
    return copy;
  }
  if (value instanceof ArrayBuffer) {
    let copy = READ_ONLY_SPATIAL_PROJECTIONS.get(value);
    if (copy === undefined) {
      copy = value.slice(0);
      READ_ONLY_SPATIAL_PROJECTIONS.set(value, copy);
    }
    return copy;
  }
  const cached = READ_ONLY_SPATIAL_PROJECTIONS.get(value);
  if (cached !== undefined) return cached;
  if (!Reflect.isExtensible(value)) {
    const rawPrototype = Reflect.getPrototypeOf(value);
    const projectedPrototype = rawPrototype === null
      ? null
      : getReadOnlySpatialProjection(
          rawPrototype,
          `${owner} prototype`
        );
    const copy = Array.isArray(value)
      ? []
      : Object.create(projectedPrototype);
    if (Array.isArray(value)) {
      Reflect.setPrototypeOf(copy, projectedPrototype);
    }
    READ_ONLY_SPATIAL_PROJECTIONS.set(value, copy);
    for (const property of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && property === 'length') continue;
      const descriptor =
        Reflect.getOwnPropertyDescriptor(value, property);
      Object.defineProperty(copy, property, {
        configurable: false,
        enumerable: descriptor?.enumerable ?? false,
        writable: false,
        value: getReadOnlySpatialProjection(
          Reflect.get(value, property, value),
          `${owner}.${String(property)}`
        ),
      });
    }
    return Object.freeze(copy);
  }

  const projection = new Proxy(value, {
    get(target, property, receiver) {
      const nested = Reflect.get(target, property, receiver);
      if (typeof nested !== 'function') {
        return getReadOnlySpatialProjection(
          nested,
          `${owner}.${String(property)}`
        );
      }
      let methods = READ_ONLY_SPATIAL_METHODS.get(target);
      if (methods === undefined) {
        methods = new Map();
        READ_ONLY_SPATIAL_METHODS.set(target, methods);
      }
      let method = methods.get(property);
      if (method !== undefined) return method;
      method = function readOnlySpatialMethod(...args) {
        if (
          READ_ONLY_MUTATOR_METHODS.has(property) ||
          (
            typeof property === 'string' &&
            property.startsWith('_')
          )
        ) {
          throw new TypeError(
            `${owner}.${String(property)} is unavailable on a read-only spatial projection.`
          );
        }
        const exactArgs = args.map((arg, index) => {
          if (typeof arg !== 'function') return arg;
          if (SPATIAL_PRIMITIVE_VISITOR_METHODS.has(property)) {
            return function projectedSpatialIndexVisitor(cellIndex) {
              return arg(cellIndex);
            };
          }
          return function projectedSpatialCallback(...callbackArgs) {
            return Reflect.apply(
              arg,
              this,
              callbackArgs.map((callbackArg, callbackIndex) =>
                getReadOnlySpatialProjection(
                  callbackArg,
                  `${owner}.${String(property)} callback argument ${callbackIndex}`
                )
              )
            );
          };
        });
        return getReadOnlySpatialProjection(
          Reflect.apply(nested, target, exactArgs),
          `${owner}.${String(property)} result`
        );
      };
      methods.set(property, method);
      return method;
    },
    set() {
      throw new TypeError(`${owner} is read-only.`);
    },
    defineProperty() {
      throw new TypeError(`${owner} is read-only.`);
    },
    deleteProperty() {
      throw new TypeError(`${owner} is read-only.`);
    },
    setPrototypeOf() {
      throw new TypeError(`${owner} prototype is read-only.`);
    },
    getPrototypeOf(target) {
      const prototype = Reflect.getPrototypeOf(target);
      return prototype === null
        ? null
        : getReadOnlySpatialProjection(
            prototype,
            `${owner} prototype`
          );
    },
    preventExtensions() {
      throw new TypeError(`${owner} cannot be made non-extensible.`);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(target, property);
      if (
        descriptor === undefined ||
        descriptor.configurable === false ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return descriptor;
      }
      return {
        ...descriptor,
        value: getReadOnlySpatialProjection(
          descriptor.value,
          `${owner}.${String(property)}`
        ),
      };
    },
  });
  READ_ONLY_SPATIAL_PROJECTIONS.set(value, projection);
  return projection;
}

function getReadOnlyLodProjection(lodBuffers) {
  if (lodBuffers.length === 0) return EMPTY_LOD_PROJECTION;
  let projection = READ_ONLY_LOD_PROJECTIONS.get(lodBuffers);
  if (projection !== undefined) return projection;
  projection = Object.freeze(
    lodBuffers.map(metadata => Object.freeze({ ...metadata }))
  );
  READ_ONLY_LOD_PROJECTIONS.set(lodBuffers, projection);
  return projection;
}

export {
  EMPTY_LOD_PROJECTION,
  READ_ONLY_LOD_PROJECTIONS,
  READ_ONLY_SPATIAL_PROJECTIONS,
  READ_ONLY_SPATIAL_METHODS,
  READ_ONLY_MUTATOR_METHODS,
  SPATIAL_PRIMITIVE_VISITOR_METHODS,
  getReadOnlySpatialProjection,
  getReadOnlyLodProjection,
};
