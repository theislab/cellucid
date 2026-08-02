/**
 * The guarded renderer facade the viewer hands out, and the terminal errors
 * it raises.
 *
 * `createViewerRendererFacade` wraps one HighPerfRenderer in a Proxy that keeps
 * working while the viewer is live and refuses every method call, property
 * write and mutating collection operation once the viewer is disposed or its
 * WebGL context is lost. Read-only owners are projected as detached copies so
 * a caller holding a stale reference cannot reach retired GPU state.
 *
 * It closes over nothing from the viewer: the whole contract is the
 * `(renderer, getTerminalState)` pair it is called with.
 */

function createViewerDisposedError(methodName) {
  const error = new Error(
    `Viewer method "${methodName}" is unavailable after dispose(); ` +
    'create a new viewer instance.'
  );
  error.name = 'ViewerDisposedError';
  return error;
}

function createViewerContextLostError(ownerName) {
  const error = new Error(
    `${ownerName} is unavailable after WebGL context loss; ` +
    'reload Cellucid to create a new renderer.'
  );
  error.name = 'ViewerContextLostError';
  return error;
}

function createRendererDisposedError(ownerName) {
  const error = new Error(
    `${ownerName} is unavailable after viewer dispose(); ` +
    'create a new viewer instance.'
  );
  error.name = 'ViewerDisposedError';
  return error;
}

export function createViewerRendererFacade(renderer, getTerminalState) {
  const methodFacades = new Map();
  const restorationMethods = new WeakMap();
  const guardedValues = new WeakMap();
  const guardedValueTargets = new WeakMap();
  const guardedValueMethods = new WeakMap();
  const guardedReadOnlyTargets = new WeakSet();
  const guardedReadOnlyBufferCopies = new WeakMap();
  const guardedReadOnlyDetachedCopies = new WeakMap();
  const guardedLodMembershipCopies = new WeakMap();
  const READ_ONLY_RENDERER_OWNERS = new Set([
    'activeProgram',
    'buffers',
    'gl',
    'lodBuffersByDimension',
    'programs',
    'snapshotBuffers',
    'spatialIndices',
    'stats',
    'uniformLocations',
    'vao',
  ]);
  const FACADE_MUTATING_METHODS = new Set([
    'add',
    'clear',
    'copyWithin',
    'delete',
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
  const CALLBACK_METHODS = new Set([
    'every',
    'filter',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'flatMap',
    'forEach',
    'map',
    'reduce',
    'reduceRight',
    'some',
    'sort',
  ]);
  const MAP_SIZE_GETTER =
    Reflect.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  const SET_SIZE_GETTER =
    Reflect.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  const MAP_READ_INTRINSICS = new Set([
    Map.prototype.entries,
    Map.prototype.forEach,
    Map.prototype.get,
    Map.prototype.has,
    Map.prototype.keys,
    Map.prototype.values,
    Map.prototype[Symbol.iterator],
  ]);
  const MAP_MUTATING_INTRINSICS = new Set([
    Map.prototype.clear,
    Map.prototype.delete,
    Map.prototype.set,
  ]);
  const SET_READ_INTRINSICS = new Set([
    Set.prototype.entries,
    Set.prototype.forEach,
    Set.prototype.has,
    Set.prototype.keys,
    Set.prototype.values,
    Set.prototype[Symbol.iterator],
  ]);
  const SET_MUTATING_INTRINSICS = new Set([
    Set.prototype.add,
    Set.prototype.clear,
    Set.prototype.delete,
  ]);
  const MAP_ITERATOR_PROTOTYPE =
    Reflect.getPrototypeOf(new Map().entries());
  const SET_ITERATOR_PROTOTYPE =
    Reflect.getPrototypeOf(new Set().entries());
  const MAP_ITERATOR_NEXT = MAP_ITERATOR_PROTOTYPE.next;
  const SET_ITERATOR_NEXT = SET_ITERATOR_PROTOTYPE.next;
  const NATIVE_SLOT_READ_POLICY =
    Object.freeze({ mutates: false, callback: false });
  const NATIVE_SLOT_CALLBACK_POLICY =
    Object.freeze({ mutates: false, callback: true });
  const NATIVE_SLOT_MUTATING_POLICY =
    Object.freeze({ mutates: true, callback: false });
  const getNativeSlotMethodPolicy = (target, method) => {
    if (target instanceof Map) {
      if (MAP_MUTATING_INTRINSICS.has(method)) {
        return NATIVE_SLOT_MUTATING_POLICY;
      }
      if (MAP_READ_INTRINSICS.has(method)) {
        return method === Map.prototype.forEach
          ? NATIVE_SLOT_CALLBACK_POLICY
          : NATIVE_SLOT_READ_POLICY;
      }
      return null;
    }
    if (target instanceof Set) {
      if (SET_MUTATING_INTRINSICS.has(method)) {
        return NATIVE_SLOT_MUTATING_POLICY;
      }
      if (SET_READ_INTRINSICS.has(method)) {
        return method === Set.prototype.forEach
          ? NATIVE_SLOT_CALLBACK_POLICY
          : NATIVE_SLOT_READ_POLICY;
      }
      return null;
    }
    if (
      method === MAP_ITERATOR_NEXT &&
      MAP_ITERATOR_PROTOTYPE.isPrototypeOf(target)
    ) {
      return NATIVE_SLOT_READ_POLICY;
    }
    if (
      method === SET_ITERATOR_NEXT &&
      SET_ITERATOR_PROTOTYPE.isPrototypeOf(target)
    ) {
      return NATIVE_SLOT_READ_POLICY;
    }
    return null;
  };
  const assertMutable = ownerName => {
    const terminalState = getTerminalState();
    if (terminalState === 'disposed') {
      throw createRendererDisposedError(ownerName);
    }
    if (terminalState === 'context-lost') {
      throw createViewerContextLostError(ownerName);
    }
  };
  const isReadOnlyRendererOwner = property => (
    READ_ONLY_RENDERER_OWNERS.has(property) ||
    (
      typeof property === 'string' &&
      property.startsWith('_')
    )
  );
  const isPrivateRendererProperty = property => (
    typeof property === 'string' &&
    property.startsWith('_')
  );
  const findPropertyDescriptor = (target, property) => {
    let owner = target;
    while (owner !== null) {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(owner, property);
      if (descriptor !== undefined) {
        return { descriptor, owner };
      }
      owner = Reflect.getPrototypeOf(owner);
    }
    return null;
  };
  const throwPrivateRendererCallable = (
    ownerName,
    property
  ) => {
    assertMutable(`${ownerName} "${String(property)}"`);
    throw new TypeError(
      `Private renderer callable "${String(property)}" is unavailable through the viewer facade.`
    );
  };
  const readWithoutTerminalAccessor = (
    target,
    property,
    receiver,
    ownerName
  ) => {
    const terminalState = getTerminalState();
    if (
      terminalState !== 'disposed' &&
      terminalState !== 'context-lost'
    ) {
      return Reflect.get(target, property, receiver);
    }

    // Terminal diagnostics may still inspect inert data publications, but
    // they must never execute an accessor installed before loss/disposal.
    // Walk exact descriptors and return only a data value; unknown or
    // accessor-backed reads take the same terminal fence as a method call.
    let descriptorOwner = target;
    while (descriptorOwner !== null) {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(descriptorOwner, property);
      if (descriptor !== undefined) {
        if (Object.hasOwn(descriptor, 'value')) {
          return descriptor.value;
        }
        assertMutable(ownerName);
      }
      descriptorOwner = Reflect.getPrototypeOf(descriptorOwner);
    }
    assertMutable(ownerName);
    return undefined;
  };

  const unwrapGuardedValue = value => (
    (
      value !== null &&
      (
        typeof value === 'object' ||
        typeof value === 'function'
      ) &&
      guardedValueTargets.has(value)
    )
      ? guardedValueTargets.get(value)
      : value
  );

  const canGuardValue = value => {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      return false;
    }
    // BufferSource identities and browser-owned opaque WebGL handles must
    // remain directly consumable by WebGL. Renderer-owned records,
    // collections, and class instances are safe to membrane.
    if (
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      return false;
    }
    const tag = Object.prototype.toString.call(value);
    return !tag.startsWith('[object WebGL');
  };

  const isInertFrozenIdentityToken = value => {
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.isFrozen(value) ||
      Reflect.ownKeys(value).length !== 0
    ) {
      return false;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return (
      prototype === null ||
      prototype === Object.prototype
    );
  };

  const hasReadOnlyProxyInvariantHazard = value => {
    for (const property of Reflect.ownKeys(value)) {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(value, property);
      if (!descriptor || descriptor.configurable !== false) continue;
      if (!Object.hasOwn(descriptor, 'value')) {
        // A non-configurable accessor descriptor cannot be replaced by a
        // guarded getter in a Proxy descriptor trap. Detach the owner so the
        // raw getter/setter identity and any closure-owned state cannot escape.
        return true;
      }
      if (
        descriptor.writable === false &&
        descriptor.value !== null &&
        (
          typeof descriptor.value === 'object' ||
          typeof descriptor.value === 'function'
        ) &&
        (
          descriptor.value instanceof ArrayBuffer ||
          ArrayBuffer.isView(descriptor.value) ||
          canGuardValue(descriptor.value)
        )
      ) {
        // Proxy [[Get]] must return this exact value. A detached owner is the
        // only way to project mutable data behind a non-writable invariant.
        return true;
      }
    }
    return false;
  };

  const guardValue = (value, ownerName, readOnly = false) => {
    if (value === renderer) {
      return rendererFacade;
    }
    if (
      guardedValueTargets.has(value) ||
      value === rendererFacade
    ) {
      return value;
    }
    if (
      readOnly &&
      (
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)
      )
    ) {
      let copy = guardedReadOnlyBufferCopies.get(value);
      if (copy === undefined) {
        if (value instanceof ArrayBuffer) {
          copy = value.slice(0);
        } else if (value instanceof DataView) {
          copy = new DataView(value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength
          ));
        } else {
          copy = new value.constructor(value);
        }
        guardedReadOnlyBufferCopies.set(value, copy);
      }
      return copy;
    }
    if (!canGuardValue(value)) return value;
    if (
      readOnly &&
      (
        (
          !Reflect.isExtensible(value) &&
          !isInertFrozenIdentityToken(value)
        ) ||
        hasReadOnlyProxyInvariantHazard(value)
      )
    ) {
      const cachedDetached =
        guardedReadOnlyDetachedCopies.get(value);
      if (cachedDetached !== undefined) {
        return cachedDetached;
      }
      if (value instanceof Map) {
        const detachedMap = new Map();
        const projectedMap = guardValue(
          detachedMap,
          ownerName,
          true
        );
        guardedReadOnlyDetachedCopies.set(value, projectedMap);
        for (const [entryKey, entryValue] of value) {
          detachedMap.set(
            guardValue(
              entryKey,
              `${ownerName} key`,
              true
            ),
            guardValue(
              entryValue,
              `${ownerName} value`,
              true
            )
          );
        }
        return projectedMap;
      }
      if (value instanceof Set) {
        const detachedSet = new Set();
        const projectedSet = guardValue(
          detachedSet,
          ownerName,
          true
        );
        guardedReadOnlyDetachedCopies.set(value, projectedSet);
        for (const entryValue of value) {
          detachedSet.add(
            guardValue(
              entryValue,
              `${ownerName} value`,
              true
            )
          );
        }
        return projectedSet;
      }

      const detached = Array.isArray(value)
        ? []
        : Object.create(null);
      // Publish the skeleton before recursion so a frozen cyclic record
      // remains finite and retains exact alias relationships in its detached
      // diagnostic projection.
      guardedReadOnlyDetachedCopies.set(value, detached);
      for (const property of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && property === 'length') continue;
        const descriptor =
          Reflect.getOwnPropertyDescriptor(value, property);
        if (!descriptor) continue;
        if (Object.hasOwn(descriptor, 'value')) {
          const detachedValue = (
            isPrivateRendererProperty(property) &&
            typeof descriptor.value === 'function'
          )
            ? function unavailableDetachedPrivateRendererMethod() {
                throwPrivateRendererCallable(
                  ownerName,
                  property
                );
              }
            : guardValue(
                descriptor.value,
                `${ownerName} property "${String(property)}"`,
                true
              );
          Object.defineProperty(detached, property, {
            configurable: false,
            enumerable: descriptor.enumerable,
            writable: false,
            value: detachedValue,
          });
        } else {
          const privateAccessor =
            isPrivateRendererProperty(property);
          Object.defineProperty(detached, property, {
            configurable: false,
            enumerable: descriptor.enumerable,
            get: typeof descriptor.get === 'function'
              ? (
                  privateAccessor
                    ? function unavailableDetachedPrivateRendererGetter() {
                        throwPrivateRendererCallable(
                          ownerName,
                          property
                        );
                      }
                    : function unavailableDetachedReadOnlyGetter() {
                        assertMutable(
                          `${ownerName} property "${String(property)}" getter`
                        );
                        throw new TypeError(
                          `${ownerName} has a non-configurable accessor that ` +
                          'is unavailable through the read-only renderer facade.'
                        );
                      }
                )
              : undefined,
          });
        }
      }
      Object.freeze(detached);
      return detached;
    }
    if (readOnly) guardedReadOnlyTargets.add(value);
    const existing = guardedValues.get(value);
    if (existing) return existing;

    let valueProxy = null;
    valueProxy = new Proxy(value, {
      get(target, property) {
        const targetIsReadOnly =
          guardedReadOnlyTargets.has(target);
        const resolvedProperty =
          findPropertyDescriptor(target, property);
        const resolvedDescriptor = resolvedProperty?.descriptor;
        if (
          targetIsReadOnly &&
          isPrivateRendererProperty(property) &&
          resolvedDescriptor !== undefined &&
          !Object.hasOwn(resolvedDescriptor, 'value')
        ) {
          throwPrivateRendererCallable(ownerName, property);
        }
        const invariantDescriptor =
          Reflect.getOwnPropertyDescriptor(target, property);
        if (
          targetIsReadOnly &&
          invariantDescriptor?.configurable === false &&
          (
            !Object.hasOwn(invariantDescriptor, 'value') ||
            (
              invariantDescriptor.writable === false &&
              invariantDescriptor.value !== null &&
              (
                typeof invariantDescriptor.value === 'object' ||
                typeof invariantDescriptor.value === 'function'
              ) &&
              (
                invariantDescriptor.value instanceof ArrayBuffer ||
                ArrayBuffer.isView(invariantDescriptor.value) ||
                canGuardValue(invariantDescriptor.value)
              )
            )
          )
        ) {
          // This can occur only if the raw owner acquired a new invariant
          // after its facade was cached. Throw before executing or disclosing
          // it; a Proxy is otherwise required to return the exact raw value.
          throw new TypeError(
            `${ownerName} acquired an unsafe non-configurable property.`
          );
        }
        let nestedValue;
        try {
          // Custom accessors receive the membrane as `this`, so a getter that
          // returns `this` cannot disclose its raw ownership target.
          nestedValue = readWithoutTerminalAccessor(
            target,
            property,
            valueProxy,
            `${ownerName} property "${String(property)}"`
          );
        } catch (error) {
          const exactNativeMapSize = (
            target instanceof Map &&
            resolvedProperty?.owner === Map.prototype &&
            resolvedDescriptor?.get === MAP_SIZE_GETTER
          );
          const exactNativeSetSize = (
            target instanceof Set &&
            resolvedProperty?.owner === Set.prototype &&
            resolvedDescriptor?.get === SET_SIZE_GETTER
          );
          // Only the exact native collection-size accessors may retry with
          // their internal-slot owner. A custom accessor on a Map/Set must
          // retain the membrane receiver even when it deliberately throws.
          if (!exactNativeMapSize && !exactNativeSetSize) throw error;
          nestedValue = readWithoutTerminalAccessor(
            target,
            property,
            target,
            `${ownerName} property "${String(property)}"`
          );
        }
        if (typeof nestedValue === 'function') {
          let methods = guardedValueMethods.get(target);
          if (!methods) {
            methods = new Map();
            guardedValueMethods.set(target, methods);
          }
          const cached = methods.get(property);
          if (cached?.source === nestedValue) {
            return cached.facade;
          }
          const privateMethod = (
            targetIsReadOnly &&
            isPrivateRendererProperty(property)
          );
          const methodFacade = privateMethod
            ? function unavailablePrivateRendererValueMethod() {
                throwPrivateRendererCallable(
                  ownerName,
                  property
                );
              }
            : function guardedRendererValueMethod(...args) {
                assertMutable(
                  `${ownerName} method "${String(property)}"`
                );
                const nativeSlotPolicy =
                  targetIsReadOnly
                    ? getNativeSlotMethodPolicy(target, nestedValue)
                    : null;
                if (
                  targetIsReadOnly &&
                  (
                    FACADE_MUTATING_METHODS.has(property) ||
                    nativeSlotPolicy?.mutates === true
                  )
                ) {
                  throw new TypeError(`${ownerName} is read-only.`);
                }
                // Mutable renderer owners and exact native collection
                // intrinsics consume their underlying identities. User code
                // reached through a read-only owner must retain guarded
                // receivers and arguments so it cannot recover raw state.
                const exactArgs = (
                  !targetIsReadOnly || nativeSlotPolicy !== null
                )
                  ? args.map(unwrapGuardedValue)
                  : args;
                if (
                  (
                    CALLBACK_METHODS.has(property) ||
                    nativeSlotPolicy?.callback === true
                  ) &&
                  typeof args[0] === 'function'
                ) {
                  const callback = args[0];
                  exactArgs[0] = function guardedCollectionCallback(
                    ...callbackArgs
                  ) {
                    return Reflect.apply(
                      callback,
                      guardValue(
                        this,
                        `${ownerName} method "${String(property)}" callback this`,
                        targetIsReadOnly
                      ),
                      callbackArgs.map((callbackArg, index) =>
                        guardValue(
                          callbackArg,
                          `${ownerName} method "${String(property)}" callback argument ${index}`,
                          targetIsReadOnly
                        )
                      )
                    );
                  };
                }
                const methodReceiver = (
                  targetIsReadOnly && nativeSlotPolicy === null
                )
                  ? valueProxy
                  : target;
                const result = Reflect.apply(
                  nestedValue,
                  methodReceiver,
                  exactArgs
                );
                return guardValue(
                  result,
                  `${ownerName} method "${String(property)}" result`,
                  targetIsReadOnly
                );
              };
          methods.set(property, {
            source: nestedValue,
            facade: methodFacade,
          });
          return methodFacade;
        }
        const descriptor =
          Reflect.getOwnPropertyDescriptor(target, property);
        if (
          descriptor &&
          descriptor.configurable === false &&
          Object.hasOwn(descriptor, 'value') &&
          descriptor.writable === false
        ) {
          // Proxy invariants require the exact frozen data-property value.
          return nestedValue;
        }
        return guardValue(
          nestedValue,
          `${ownerName} property "${String(property)}"`,
          targetIsReadOnly
        );
      },
      set(target, property, nestedValue, receiver) {
        assertMutable(
          `${ownerName} property "${String(property)}"`
        );
        if (guardedReadOnlyTargets.has(target)) {
          if (receiver === valueProxy || receiver === target) {
            throw new TypeError(`${ownerName} is read-only.`);
          }
          // A read-only projection may legitimately be the prototype of a
          // newly constructed result. Preserve ordinary inherited writable
          // data-property semantics by publishing only on that distinct
          // receiver; never invoke a renderer-owned accessor while doing so.
          const inherited =
            findPropertyDescriptor(target, property)?.descriptor;
          if (
            inherited !== undefined &&
            (
              !Object.hasOwn(inherited, 'value') ||
              inherited.writable !== true
            )
          ) {
            return false;
          }
          return Reflect.defineProperty(receiver, property, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: nestedValue,
          });
        }
        return Reflect.set(
          target,
          property,
          unwrapGuardedValue(nestedValue),
          target
        );
      },
      defineProperty(target, property, descriptor) {
        assertMutable(
          `${ownerName} property "${String(property)}"`
        );
        if (guardedReadOnlyTargets.has(target)) {
          throw new TypeError(`${ownerName} is read-only.`);
        }
        if (descriptor.configurable !== true) {
          throw new TypeError(
            `${ownerName} cannot publish a non-configurable facade property.`
          );
        }
        const nextDescriptor = Object.hasOwn(descriptor, 'value')
          ? {
              ...descriptor,
              value: unwrapGuardedValue(descriptor.value),
            }
          : descriptor;
        return Reflect.defineProperty(
          target,
          property,
          nextDescriptor
        );
      },
      deleteProperty(target, property) {
        assertMutable(
          `${ownerName} property "${String(property)}"`
        );
        if (guardedReadOnlyTargets.has(target)) {
          throw new TypeError(`${ownerName} is read-only.`);
        }
        return Reflect.deleteProperty(target, property);
      },
      getOwnPropertyDescriptor(target, property) {
        const descriptor =
          Reflect.getOwnPropertyDescriptor(target, property);
        if (!descriptor) {
          return descriptor;
        }
        const targetIsReadOnly =
          guardedReadOnlyTargets.has(target);
        if (descriptor.configurable === false) {
          if (!targetIsReadOnly) return descriptor;
          if (
            !Object.hasOwn(descriptor, 'value') ||
            descriptor.writable === false
          ) {
            // Initial invariant hazards are detached before proxy creation.
            // A later raw mutation cannot be projected compatibly.
            throw new TypeError(
              `${ownerName} acquired an unsafe non-configurable property.`
            );
          }
          return {
            ...descriptor,
            value: guardValue(
              descriptor.value,
              `${ownerName} property "${String(property)}"`,
              true
            ),
          };
        }
        if (!Object.hasOwn(descriptor, 'value')) {
          if (
            targetIsReadOnly &&
            isPrivateRendererProperty(property)
          ) {
            return {
              ...descriptor,
              get: typeof descriptor.get === 'function'
                ? function unavailablePrivateRendererValueGetter() {
                    throwPrivateRendererCallable(
                      ownerName,
                      property
                    );
                  }
                : descriptor.get,
              set: typeof descriptor.set === 'function'
                ? function unavailablePrivateRendererValueSetter() {
                    throwPrivateRendererCallable(
                      ownerName,
                      property
                    );
                  }
                : descriptor.set,
            };
          }
          return {
            ...descriptor,
            get: typeof descriptor.get === 'function'
              ? function guardedRendererValueGetter() {
                  assertMutable(
                    `${ownerName} property "${String(property)}" getter`
                  );
                  return guardValue(
                    Reflect.apply(
                      descriptor.get,
                      targetIsReadOnly ? valueProxy : target,
                      []
                    ),
                    `${ownerName} property "${String(property)}" getter result`,
                    targetIsReadOnly
                  );
                }
              : descriptor.get,
            set: typeof descriptor.set === 'function'
              ? function guardedRendererValueSetter(nextValue) {
                  assertMutable(
                    `${ownerName} property "${String(property)}" setter`
                  );
                  if (targetIsReadOnly) {
                    throw new TypeError(`${ownerName} is read-only.`);
                  }
                  return Reflect.apply(
                    descriptor.set,
                    target,
                    [unwrapGuardedValue(nextValue)]
                  );
                }
              : descriptor.set,
          };
        }
        if (
          targetIsReadOnly &&
          isPrivateRendererProperty(property) &&
          typeof descriptor.value === 'function'
        ) {
          return {
            ...descriptor,
            value: Reflect.get(valueProxy, property),
          };
        }
        return {
          ...descriptor,
          value: guardValue(
            descriptor.value,
            `${ownerName} property "${String(property)}"`,
            targetIsReadOnly
          ),
        };
      },
      setPrototypeOf(target, prototype) {
        assertMutable(`${ownerName} prototype`);
        throw new TypeError(
          `${ownerName} prototype mutation is unavailable through the renderer facade.`
        );
      },
      getPrototypeOf(target) {
        if (!Reflect.isExtensible(target)) {
          return Reflect.getPrototypeOf(target);
        }
        return guardValue(
          Reflect.getPrototypeOf(target),
          `${ownerName} prototype`,
          guardedReadOnlyTargets.has(target)
        );
      },
      preventExtensions(target) {
        assertMutable(`${ownerName} extensibility`);
        throw new TypeError(
          `${ownerName} cannot be made non-extensible through the renderer facade.`
        );
      },
      apply(target, thisArg, args) {
        assertMutable(`${ownerName} call`);
        const targetIsReadOnly =
          guardedReadOnlyTargets.has(target);
        return guardValue(
          Reflect.apply(
            target,
            targetIsReadOnly
              ? thisArg
              : unwrapGuardedValue(thisArg),
            targetIsReadOnly
              ? args
              : args.map(unwrapGuardedValue)
          ),
          `${ownerName} call result`,
          targetIsReadOnly
        );
      },
      construct(target, args, newTarget) {
        assertMutable(`${ownerName} construction`);
        const targetIsReadOnly =
          guardedReadOnlyTargets.has(target);
        return guardValue(
          Reflect.construct(
            target,
            targetIsReadOnly
              ? args
              : args.map(unwrapGuardedValue),
            targetIsReadOnly
              ? newTarget
              : unwrapGuardedValue(newTarget)
          ),
          `${ownerName} construction result`,
          targetIsReadOnly
        );
      },
    });
    guardedValues.set(value, valueProxy);
    guardedValueTargets.set(valueProxy, value);
    return valueProxy;
  };

  const guardRendererMethodResult = (
    value,
    property,
    ownerName
  ) => {
    if (
      value !== null &&
      (
        property === 'getCurrentLodMembership' ||
        property === 'getCurrentLodSequentialMembership'
      )
    ) {
      let detached = guardedLodMembershipCopies.get(value);
      if (detached === undefined) {
        detached = Object.freeze({
          ...value,
          ...(value.admissionLevels instanceof Uint8Array
            ? {
                admissionLevels:
                  new Uint8Array(value.admissionLevels),
              }
            : {}),
          ...(value.indices instanceof Uint32Array
            ? { indices: new Uint32Array(value.indices) }
            : {}),
          // generationToken is an inert frozen identity certificate. Preserve
          // it so callers can compare generations without gaining mutable data.
          generationToken: value.generationToken,
        });
        guardedLodMembershipCopies.set(value, detached);
      }
      return detached;
    }
    return guardValue(value, ownerName, true);
  };

  const RawRendererConstructor = renderer.constructor;
  const rendererConstructorFacade = function RendererFacadeConstructor(
    ...args
  ) {
    assertMutable('Renderer constructor');
    if (new.target === undefined) {
      return Reflect.apply(RawRendererConstructor, undefined, args);
    }
    return Reflect.construct(RawRendererConstructor, args);
  };
  Object.defineProperty(
    rendererConstructorFacade,
    Symbol.hasInstance,
    {
      value(candidate) {
        return candidate instanceof RawRendererConstructor;
      },
    }
  );
  Object.freeze(rendererConstructorFacade.prototype);
  Object.freeze(rendererConstructorFacade);

  let rendererFacade = null;
  rendererFacade = new Proxy(renderer, {
    get(target, property) {
      const resolvedDescriptor =
        findPropertyDescriptor(target, property)?.descriptor;
      if (
        isPrivateRendererProperty(property) &&
        resolvedDescriptor !== undefined &&
        !Object.hasOwn(resolvedDescriptor, 'value')
      ) {
        throwPrivateRendererCallable('Renderer property', property);
      }
      const value = readWithoutTerminalAccessor(
        target,
        property,
        rendererFacade,
        `Renderer property "${String(property)}"`
      );
      if (
        property === 'constructor'
      ) {
        return rendererConstructorFacade;
      }
      if (typeof value !== 'function') {
        return guardValue(
          value,
          `Renderer property "${String(property)}"`,
          isReadOnlyRendererOwner(property)
        );
      }
      const cached = methodFacades.get(property);
      if (cached?.source !== value) {
        const isPrivateMethod =
          isPrivateRendererProperty(property);
        const methodFacade = isPrivateMethod
          ? function unavailablePrivateRendererMethod() {
              assertMutable(`Renderer method "${String(property)}"`);
              throw new TypeError(
                `Private renderer method "${String(property)}" is unavailable through the viewer facade.`
              );
            }
          : function guardedRendererMethod(...args) {
              assertMutable(`Renderer method "${String(property)}"`);
              return guardRendererMethodResult(
                Reflect.apply(
                  value,
                  target,
                  args.map(unwrapGuardedValue)
                ),
                property,
                `Renderer method "${String(property)}" result`,
              );
            };
        if (!isPrivateMethod) {
          restorationMethods.set(methodFacade, value);
          Object.defineProperty(methodFacade, 'bind', {
            configurable: true,
            value(thisArg, ...args) {
              const boundFacade = Function.prototype.bind.call(
                methodFacade,
                thisArg,
                ...args
              );
              restorationMethods.set(boundFacade, value);
              return boundFacade;
            },
          });
        }
        methodFacades.set(property, {
          source: value,
          facade: methodFacade,
        });
      }
      return methodFacades.get(property).facade;
    },
    set(target, property, value) {
      assertMutable(`Renderer property "${String(property)}"`);
      if (isReadOnlyRendererOwner(property)) {
        throw new TypeError(
          `Renderer property "${String(property)}" is read-only.`
        );
      }
      const nextValue = (
        typeof value === 'function' &&
        restorationMethods.has(value)
      )
        ? restorationMethods.get(value)
        : unwrapGuardedValue(value);
      return Reflect.set(target, property, nextValue, target);
    },
    defineProperty(target, property, descriptor) {
      assertMutable(`Renderer property "${String(property)}"`);
      if (isReadOnlyRendererOwner(property)) {
        throw new TypeError(
          `Renderer property "${String(property)}" is read-only.`
        );
      }
      if (descriptor.configurable !== true) {
        throw new TypeError(
          'Renderer cannot publish a non-configurable facade property.'
        );
      }
      if (
        Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')
      ) {
        throw new TypeError(
          'Renderer accessor publication is unavailable through its facade.'
        );
      }
      const nextDescriptor = (
        Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function' &&
        restorationMethods.has(descriptor.value)
      )
        ? {
            ...descriptor,
            value: restorationMethods.get(descriptor.value),
          }
        : (
            Object.hasOwn(descriptor, 'value')
              ? {
                  ...descriptor,
                  value: unwrapGuardedValue(descriptor.value),
                }
              : descriptor
          );
      return Reflect.defineProperty(target, property, nextDescriptor);
    },
    deleteProperty(target, property) {
      assertMutable(`Renderer property "${String(property)}"`);
      if (isReadOnlyRendererOwner(property)) {
        throw new TypeError(
          `Renderer property "${String(property)}" is read-only.`
        );
      }
      return Reflect.deleteProperty(target, property);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor) {
        return descriptor;
      }
      const privateProperty =
        isPrivateRendererProperty(property);
      if (descriptor.configurable === false) {
        if (
          privateProperty &&
          (
            !Object.hasOwn(descriptor, 'value') ||
            typeof descriptor.value === 'function'
          )
        ) {
          throwPrivateRendererCallable(
            'Renderer property',
            property
          );
        }
        return descriptor;
      }
      if (!Object.hasOwn(descriptor, 'value')) {
        if (privateProperty) {
          return {
            ...descriptor,
            get: typeof descriptor.get === 'function'
              ? function unavailablePrivateRendererGetter() {
                  throwPrivateRendererCallable(
                    'Renderer property',
                    property
                  );
                }
              : descriptor.get,
            set: typeof descriptor.set === 'function'
              ? function unavailablePrivateRendererSetter() {
                  throwPrivateRendererCallable(
                    'Renderer property',
                    property
                  );
                }
              : descriptor.set,
          };
        }
        return {
          ...descriptor,
          get: typeof descriptor.get === 'function'
            ? function guardedRendererGetter() {
                assertMutable(
                  `Renderer property "${String(property)}" getter`
                );
                return guardValue(
                  Reflect.apply(descriptor.get, target, []),
                  `Renderer property "${String(property)}" getter result`,
                  isReadOnlyRendererOwner(property)
                );
              }
            : descriptor.get,
          set: typeof descriptor.set === 'function'
            ? function guardedRendererSetter(nextValue) {
                assertMutable(
                  `Renderer property "${String(property)}" setter`
                );
                if (isReadOnlyRendererOwner(property)) {
                  throw new TypeError(
                    `Renderer property "${String(property)}" is read-only.`
                  );
                }
                return Reflect.apply(
                  descriptor.set,
                  target,
                  [unwrapGuardedValue(nextValue)]
                );
              }
            : descriptor.set,
        };
      }
      if (
        privateProperty &&
        typeof descriptor.value === 'function'
      ) {
        return {
          ...descriptor,
          value: Reflect.get(rendererFacade, property),
        };
      }
      return {
        ...descriptor,
        value: guardValue(
          descriptor.value,
          `Renderer property "${String(property)}"`,
          isReadOnlyRendererOwner(property)
        ),
      };
    },
    setPrototypeOf(target, prototype) {
      assertMutable('Renderer prototype');
      throw new TypeError(
        'Renderer prototype mutation is unavailable through its facade.'
      );
    },
    getPrototypeOf(target) {
      if (!Reflect.isExtensible(target)) {
        return Reflect.getPrototypeOf(target);
      }
      return guardValue(
        Reflect.getPrototypeOf(target),
        'Renderer prototype',
        true
      );
    },
    preventExtensions(target) {
      assertMutable('Renderer extensibility');
      throw new TypeError(
        'Renderer cannot be made non-extensible through its facade.'
      );
    },
  });
  return rendererFacade;
}

export {
  createViewerContextLostError,
  createViewerDisposedError,
};
