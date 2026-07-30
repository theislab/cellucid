import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createViewerRendererFacade,
} from '../assets/js/rendering/viewer.js';

test('renderer facade recursively fences cached ownership and reflection escapes', () => {
  class RendererFixture {
    constructor() {
      this.programs = {
        full: { id: 'program' },
        nested: { value: 1 },
        mutateArgument(owner) {
          owner.nested.value = 77;
          owner.injected = 88;
        },
        getReturnedMutation() {
          return owner => {
            owner.nested.value = 66;
            owner.returnInjected = 55;
          };
        },
      };
      this.programs.accessorNested = { value: 5 };
      Object.defineProperty(this.programs, 'hostileAccessor', {
        configurable: true,
        get() {
          this.accessorNested.value = 6;
          this.accessorInjected = true;
          return this;
        },
      });
      this.programs.nonConfigOwner = {
        nested: { value: 10 },
      };
      Object.defineProperty(
        this.programs.nonConfigOwner,
        'hostileAccessor',
        {
          configurable: false,
          enumerable: true,
          get() {
            this.nested.value = 20;
            this.injected = true;
            return this;
          },
        },
      );
      this.buffers = {
        interleaved: { id: 'buffer' },
      };
      this.spatialMembership = Object.freeze({
        admissionLevels: new Uint8Array([8, 10]),
        indices: new Uint32Array([12, 14]),
      });
      this.spatialIndices = new Map([
        [2, {
          id: 'spatial',
          getLodMembership: () => this.spatialMembership,
        }],
      ]);
      this.mapIdentityKey = { id: 'identity-key' };
      this.spatialIndices.set(
        this.mapIdentityKey,
        { id: 'identity-value' },
      );
      this.spatialIndices.evil = function mutateMapFromCustomMethod() {
        this.set('custom-method-escaped', {});
      };
      this.spatialIndices.mutatingAlias = Map.prototype.set;
      Object.defineProperty(
        this.spatialIndices,
        'hostileAccessor',
        {
          configurable: true,
          get() {
            Map.prototype.set.call(
              this,
              'custom-accessor-escaped',
              {},
            );
            return this;
          },
        },
      );
      this.setOwner = new Set([this.mapIdentityKey]);
      this.setOwner.evil = function mutateSetFromCustomMethod() {
        this.add('custom-method-escaped');
      };
      this.setOwner.mutatingAlias = Set.prototype.add;
      Object.defineProperty(this.setOwner, 'hostileAccessor', {
        configurable: true,
        get() {
          Set.prototype.add.call(
            this,
            'custom-accessor-escaped',
          );
          return this;
        },
      });
      this.programs.setOwner = this.setOwner;
      this.stats = {
        visiblePoints: 7,
      };
      this._positions = new Float32Array([1, 2, 3]);
      this._maximumIndices = new Uint32Array([3, 5]);
      this._lodResourceOwnersByDimension = new Map([
        [2, Object.freeze({
          maximumIndices: this._maximumIndices,
          topologyOwner: Object.freeze({
            admissionLevels: new Uint8Array([4, 6]),
          }),
        })],
      ]);
      this.getterCalls = 0;
      Object.defineProperty(this, 'hostileGetter', {
        configurable: true,
        get() {
          this.getterCalls += 1;
          return { id: 'getter-result' };
        },
      });
      this.privateAccessorCalls = 0;
      Object.defineProperty(this, '_hostilePrivateAccessor', {
        configurable: true,
        get() {
          this.privateAccessorCalls += 1;
          return () => {
            this.quality = 'private-accessor';
          };
        },
        set() {
          this.privateAccessorCalls += 1;
          this.quality = 'private-setter';
        },
      });
      this._ownPrivateMethod = function ownPrivateMethod() {
        this.quality = 'own-private';
      };
      this.list = [{ id: 'entry' }];
      this.invariantOwnerData = new Uint8Array([21, 22]);
      this.invariantOwnerAccessorData =
        new Uint8Array([31, 32]);
      this.invariantOwner = {};
      Object.defineProperty(this.invariantOwner, 'lockedData', {
        configurable: false,
        enumerable: true,
        value: this.invariantOwnerData,
        writable: false,
      });
      Object.defineProperty(this.invariantOwner, 'lockedAccessor', {
        configurable: false,
        enumerable: true,
        get: () => this.invariantOwnerAccessorData,
      });
      this.writableInvariantData = new Uint8Array([41, 42]);
      this.writableInvariantOwner = {};
      Object.defineProperty(
        this.writableInvariantOwner,
        'replaceableData',
        {
          configurable: false,
          enumerable: true,
          value: this.writableInvariantData,
          writable: true,
        },
      );
      this.ReturnedConstructor = function ReturnedConstructor(value) {
        this.value = value;
      };
      const returnedIdentityProbe = function returnedIdentityProbe(
        candidate
      ) {
        return (
          this === returnedIdentityProbe &&
          candidate === returnedIdentityProbe
        );
      };
      this.returnedIdentityProbe = returnedIdentityProbe;
      this.membership = Object.freeze({
        admissionLevels: new Uint8Array([1, 2]),
        dimensionLevel: 2,
        generationToken: Object.freeze({}),
        indices: new Uint32Array([7, 9]),
        lodLevel: 1,
        pointCount: 2,
      });
      this.nestedGetter = {
        calls: 0,
        get self() {
          this.calls += 1;
          return this;
        },
      };
    }

    setQuality(value) {
      this.quality = value;
    }

    getCurrentLodMembership() {
      return this.membership;
    }

    getInvariantOwner() {
      return this.invariantOwner;
    }

    getWritableInvariantOwner() {
      return this.writableInvariantOwner;
    }

    getReturnedConstructor() {
      return this.ReturnedConstructor;
    }

    getReturnedIdentityProbe() {
      return this.returnedIdentityProbe;
    }

    acceptsReturnedConstructor(candidate) {
      return candidate === this.ReturnedConstructor;
    }

    _getSpatialIndexForViewGeneration() {
      return { positions: this._positions };
    }

    _mutateFromPrototype() {
      this.quality = 'private-prototype';
      this.disposedByPrivatePrototype = true;
    }

    mutatePrototypeReceiver(value) {
      this.prototypeMutation = value;
    }
  }

  const renderer = new RendererFixture();
  let terminalState = null;
  const facade = createViewerRendererFacade(
    renderer,
    () => terminalState,
  );

  const programs = facade.programs;
  const buffers = facade.buffers;
  const stats = facade.stats;
  const map = facade.spatialIndices;
  const setOwner = programs.setOwner;
  const list = facade.list;
  const programDescriptor =
    Object.getOwnPropertyDescriptor(facade, 'programs');
  const constructor = facade.constructor;
  const constructorPrototype = constructor.prototype;
  const rendererPrototype = Object.getPrototypeOf(facade);
  const rawRendererPrototype =
    Object.getPrototypeOf(renderer);
  const nestedGetterOwner = facade.nestedGetter;
  assert.strictEqual(nestedGetterOwner.self, nestedGetterOwner);
  const hostileGetterResult = facade.hostileGetter;
  assert.equal(hostileGetterResult.id, 'getter-result');
  const hostileGetterDescriptor =
    Object.getOwnPropertyDescriptor(facade, 'hostileGetter');
  const nestedSelfDescriptor =
    Object.getOwnPropertyDescriptor(renderer.nestedGetter, 'self');

  const detachedPositions = facade._positions;
  detachedPositions[0] = 99;
  assert.equal(renderer._positions[0], 1);
  const detachedLodOwner =
    facade._lodResourceOwnersByDimension.get(2);
  detachedLodOwner.maximumIndices[0] = 99;
  detachedLodOwner.topologyOwner.admissionLevels[0] = 99;
  assert.deepEqual([...renderer._maximumIndices], [3, 5]);
  assert.deepEqual(
    [
      ...renderer._lodResourceOwnersByDimension
        .get(2).topologyOwner.admissionLevels,
    ],
    [4, 6],
  );

  const detachedSpatialMembership =
    facade.spatialIndices.get(2).getLodMembership();
  detachedSpatialMembership.admissionLevels[0] = 99;
  detachedSpatialMembership.indices[0] = 99;
  assert.deepEqual(
    [...renderer.spatialMembership.admissionLevels],
    [8, 10],
  );
  assert.deepEqual([...renderer.spatialMembership.indices], [12, 14]);

  assert.equal(map.size, 2);
  assert.equal(setOwner.size, 1);
  const guardedIdentityKey = [...map.keys()].find(
    key => key?.id === 'identity-key',
  );
  assert.ok(guardedIdentityKey);
  assert.notStrictEqual(guardedIdentityKey, renderer.mapIdentityKey);
  assert.equal(map.has(guardedIdentityKey), true);
  assert.equal(map.get(guardedIdentityKey).id, 'identity-value');
  assert.equal(setOwner.has(guardedIdentityKey), true);
  assert.deepEqual(
    [...setOwner].map(value => value.id),
    ['identity-key'],
    'native Set iteration must retain its internal-slot receiver',
  );
  for (const mutate of [
    () => map.evil(),
    () => map.mutatingAlias('alias-escaped', {}),
    () => map.hostileAccessor,
    () => setOwner.evil(),
    () => setOwner.mutatingAlias('alias-escaped'),
    () => setOwner.hostileAccessor,
  ]) {
    assert.throws(mutate, TypeError);
  }
  assert.equal(renderer.spatialIndices.has('custom-method-escaped'), false);
  assert.equal(renderer.spatialIndices.has('alias-escaped'), false);
  assert.equal(renderer.spatialIndices.has('custom-accessor-escaped'), false);
  assert.equal(renderer.setOwner.has('custom-method-escaped'), false);
  assert.equal(renderer.setOwner.has('alias-escaped'), false);
  assert.equal(renderer.setOwner.has('custom-accessor-escaped'), false);

  assert.throws(
    () => programs.mutateArgument(programs),
    /read-only/,
  );
  const returnedMutation = programs.getReturnedMutation();
  assert.throws(
    () => Reflect.apply(returnedMutation, null, [programs]),
    /read-only/,
  );
  assert.equal(renderer.programs.nested.value, 1);
  assert.equal(renderer.programs.injected, undefined);
  assert.equal(renderer.programs.returnInjected, undefined);

  assert.throws(() => programs.hostileAccessor, /read-only/);
  const hostileProgramsAccessor =
    Object.getOwnPropertyDescriptor(
      programs,
      'hostileAccessor',
    );
  assert.throws(
    () => hostileProgramsAccessor.get(),
    /read-only/,
  );
  const nonConfigOwner = programs.nonConfigOwner;
  const nonConfigAccessor =
    Object.getOwnPropertyDescriptor(
      nonConfigOwner,
      'hostileAccessor',
    );
  assert.throws(
    () => nonConfigOwner.hostileAccessor,
    /non-configurable accessor/,
  );
  assert.throws(
    () => nonConfigAccessor.get(),
    /non-configurable accessor/,
  );
  assert.equal(renderer.programs.accessorNested.value, 5);
  assert.equal(renderer.programs.accessorInjected, undefined);
  assert.equal(renderer.programs.nonConfigOwner.nested.value, 10);
  assert.equal(renderer.programs.nonConfigOwner.injected, undefined);

  const membership = facade.getCurrentLodMembership();
  assert.notStrictEqual(membership.indices, renderer.membership.indices);
  assert.notStrictEqual(
    membership.admissionLevels,
    renderer.membership.admissionLevels,
  );
  assert.strictEqual(
    membership.generationToken,
    renderer.membership.generationToken,
  );
  membership.indices[0] = 99;
  membership.admissionLevels[0] = 99;
  assert.deepEqual([...renderer.membership.indices], [7, 9]);
  assert.deepEqual([...renderer.membership.admissionLevels], [1, 2]);

  const invariantOwner = facade.getInvariantOwner();
  const lockedDataDescriptor =
    Object.getOwnPropertyDescriptor(invariantOwner, 'lockedData');
  const lockedAccessorDescriptor =
    Object.getOwnPropertyDescriptor(invariantOwner, 'lockedAccessor');
  invariantOwner.lockedData[0] = 99;
  lockedDataDescriptor.value[1] = 99;
  assert.throws(
    () => invariantOwner.lockedAccessor,
    /non-configurable accessor/,
  );
  assert.throws(
    () => lockedAccessorDescriptor.get(),
    /non-configurable accessor/,
  );
  assert.deepEqual([...renderer.invariantOwnerData], [21, 22]);
  assert.deepEqual(
    [...renderer.invariantOwnerAccessorData],
    [31, 32],
  );

  const writableInvariantOwner =
    facade.getWritableInvariantOwner();
  const writableInvariantDescriptor =
    Object.getOwnPropertyDescriptor(
      writableInvariantOwner,
      'replaceableData',
    );
  writableInvariantOwner.replaceableData[0] = 99;
  writableInvariantDescriptor.value[1] = 99;
  assert.deepEqual([...renderer.writableInvariantData], [41, 42]);

  const ReturnedConstructor = facade.getReturnedConstructor();
  const returnedInstance = new ReturnedConstructor(51);
  assert.equal(returnedInstance.value, 51);
  assert.throws(
    () => { returnedInstance.value = 52; },
    /read-only/,
  );
  assert.equal(
    facade.acceptsReturnedConstructor(ReturnedConstructor),
    true,
    'guarded function arguments must restore the exact renderer identity',
  );
  const returnedIdentityProbe =
    facade.getReturnedIdentityProbe();
  assert.equal(
    returnedIdentityProbe.call(
      returnedIdentityProbe,
      returnedIdentityProbe,
    ),
    false,
    'read-only returned functions must retain guarded this/argument owners',
  );

  const privateMethod = facade._getSpatialIndexForViewGeneration;
  const privateMethodBound = privateMethod.bind(facade);
  facade.privateAlias = privateMethod;
  Object.defineProperty(facade, 'privateDefinedAlias', {
    configurable: true,
    value: privateMethodBound,
  });
  assert.throws(() => privateMethod(), /Private renderer method/);
  assert.throws(() => facade.privateAlias(), /Private renderer method/);
  assert.throws(() => facade.privateDefinedAlias(), /Private renderer method/);

  const ownPrivateDescriptor =
    Object.getOwnPropertyDescriptor(
      facade,
      '_ownPrivateMethod',
    );
  const prototypePrivateDescriptor =
    Object.getOwnPropertyDescriptor(
      rendererPrototype,
      '_mutateFromPrototype',
    );
  const privateAccessorDescriptor =
    Object.getOwnPropertyDescriptor(
      facade,
      '_hostilePrivateAccessor',
    );
  assert.throws(
    () => ownPrivateDescriptor.value.call(facade),
    /Private renderer (?:method|callable)/,
  );
  assert.throws(
    () => rendererPrototype._mutateFromPrototype(),
    /Private renderer callable/,
  );
  assert.throws(
    () => prototypePrivateDescriptor.value.call(facade),
    /Private renderer callable/,
  );
  assert.throws(
    () => facade._hostilePrivateAccessor,
    /Private renderer callable/,
  );
  assert.throws(
    () => privateAccessorDescriptor.get.call(facade),
    /Private renderer callable/,
  );
  assert.throws(
    () => privateAccessorDescriptor.set.call(facade, () => {}),
    /Private renderer callable/,
  );
  assert.equal(renderer.privateAccessorCalls, 0);
  assert.equal(renderer.quality, undefined);
  assert.equal(renderer.disposedByPrivatePrototype, undefined);

  assert.throws(
    () => rendererPrototype.mutatePrototypeReceiver('raw-prototype'),
    /read-only/,
  );
  assert.equal(rawRendererPrototype.prototypeMutation, undefined);
  const publicPrototypeDescriptor =
    Object.getOwnPropertyDescriptor(
      rendererPrototype,
      'mutatePrototypeReceiver',
    );
  publicPrototypeDescriptor.value.call(facade, 'renderer');
  assert.equal(renderer.prototypeMutation, 'renderer');
  assert.equal(rawRendererPrototype.prototypeMutation, undefined);

  const firstQualityMethod = facade.setQuality;
  facade.setQuality = function replacementQuality(value) {
    this.replacementQuality = value;
  };
  const replacementQualityMethod = facade.setQuality;
  assert.notStrictEqual(replacementQualityMethod, firstQualityMethod);
  replacementQualityMethod('replacement');
  assert.equal(renderer.replacementQuality, 'replacement');

  let callbackMap = null;
  let callbackThis = null;
  map.forEach(function (_value, _key, owner) {
    callbackMap = owner;
    callbackThis = this;
  }, map);
  assert.strictEqual(callbackMap, map);
  assert.strictEqual(callbackThis, map);

  let callbackArray = null;
  let callbackArrayThis = null;
  list.forEach(function (_value, _index, owner) {
    callbackArray = owner;
    callbackArrayThis = this;
  }, list);
  assert.strictEqual(callbackArray, list);
  assert.strictEqual(callbackArrayThis, list);

  assert.throws(
    () => Object.defineProperty(
      programs,
      'escaped',
      { value: { id: 'raw' } },
    ),
    /read-only/,
  );
  assert.throws(() => Object.freeze(programs), /non-extensible/);
  assert.throws(() => Object.freeze(facade), /non-extensible/);
  assert.throws(
    () => { rendererPrototype.injected = () => renderer._positions; },
    /read-only/,
  );
  assert.equal(Object.isExtensible(renderer), true);
  assert.equal(Object.isExtensible(renderer.programs), true);

  assert.throws(
    () => { programs.full = { id: 'replacement' }; },
    /read-only/,
  );
  assert.throws(
    () => { constructorPrototype.dispose = () => {}; },
    TypeError,
  );
  terminalState = 'context-lost';
  const getterCallsAtFence = renderer.getterCalls;
  const nestedGetterCallsAtFence = renderer.nestedGetter.calls;

  const terminalMutations = [
    () => { programs.full = null; },
    () => { buffers.interleaved = null; },
    () => { stats.visiblePoints = 0; },
    () => map.set(3, { id: 'late' }),
    () => callbackMap.clear(),
    () => { callbackThis.extra = true; },
    () => callbackArray.push({ id: 'late' }),
    () => { callbackArrayThis.length = 0; },
    () => { programDescriptor.value.full = null; },
    () => { rendererPrototype.dispose = () => {}; },
    () => Object.setPrototypeOf(programs, null),
    () => new constructor(),
    () => facade.hostileGetter,
    () => hostileGetterDescriptor.get(),
    () => nestedGetterOwner.self,
    () => nestedSelfDescriptor.get.call(nestedGetterOwner),
    () => replacementQualityMethod('late'),
  ];
  for (const mutate of terminalMutations) {
    assert.throws(
      mutate,
      error => (
        error?.name === 'ViewerContextLostError' &&
        /unavailable after WebGL context loss/.test(error.message)
      ),
    );
  }

  assert.equal(renderer.programs.full.id, 'program');
  assert.equal(renderer.buffers.interleaved.id, 'buffer');
  assert.equal(renderer.stats.visiblePoints, 7);
  assert.equal(renderer.spatialIndices.size, 2);
  assert.equal(renderer.list.length, 1);
  assert.equal(renderer.getterCalls, getterCallsAtFence);
  assert.equal(renderer.nestedGetter.calls, nestedGetterCallsAtFence);
});
