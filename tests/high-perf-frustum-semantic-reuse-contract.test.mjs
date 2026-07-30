import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  retireRenderViewRecord,
} from '../assets/js/rendering/viewer.js';

const UNIFORM_NAMES = [
  'u_alphaTex',
  'u_alphaTexWidth',
  'u_fogColor',
  'u_fogDensity',
  'u_fogFar',
  'u_fogNear',
  'u_fov',
  'u_invAlphaTexWidth',
  'u_invLodIndexTexWidth',
  'u_lightDir',
  'u_lightingStrength',
  'u_lodIndexTex',
  'u_lodIndexTexWidth',
  'u_modelMatrix',
  'u_mvpMatrix',
  'u_pointSize',
  'u_projectionMatrix',
  'u_sizeAttenuation',
  'u_useAlphaTex',
  'u_useLodIndexTex',
  'u_viewMatrix',
  'u_viewportHeight',
];

function makeSnapshot(pointCount = 3) {
  const alphaTexData = new Uint8Array(pointCount);
  alphaTexData.fill(255);
  return {
    alphaTexData,
    alphaTexHeight: 1,
    alphaTexWidth: pointCount,
    alphaTexture: {},
    alphaTextureByteLength: alphaTexData.byteLength,
    id: 'snapshot-fixture',
    pointCount,
    vao: {},
  };
}

function identityMatrix(translationX = 0) {
  const matrix = new Float64Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[12] = translationX;
  matrix[15] = 1;
  return matrix;
}

function makeParams(viewId, mvpMatrix) {
  return {
    dimensionLevel: 2,
    fogColor: new Float32Array(3),
    fogDensity: 0,
    fov: 1,
    lightDir: new Float32Array(3),
    lightingStrength: 0,
    modelMatrix: identityMatrix(),
    mvpMatrix,
    pointSize: 1,
    projectionMatrix: identityMatrix(),
    sizeAttenuation: 1,
    viewId,
    viewMatrix: identityMatrix(),
    viewportHeight: 512,
  };
}

function makeLeaf(rank) {
  return {
    indices: Uint32Array.of(rank),
    rank,
  };
}

function makeSpatialOwner(counters, generationToken) {
  const level = {
    indices: Uint32Array.of(0, 1, 2),
    isFullDetail: false,
    pointCount: 3,
    sizeMultiplier: 1,
  };
  return {
    _lodNodeMapping: {
      generationToken,
      maximumIndices: Uint32Array.of(2, 0, 1),
    },
    ensureLodNodeMappings() {},
    _validateLodNodeMapping() {
      return this._lodNodeMapping.generationToken;
    },
    hasSameLodVisibleLeafSet(accepted, candidate) {
      if (
        !Array.isArray(accepted) ||
        !Array.isArray(candidate) ||
        accepted.length !== candidate.length
      ) {
        return false;
      }
      const acceptedLeaves = new Set(accepted);
      if (acceptedLeaves.size !== accepted.length) {
        return false;
      }
      const candidateLeaves = new Set(candidate);
      if (candidateLeaves.size !== candidate.length) {
        return false;
      }
      for (const leaf of candidateLeaves) {
        if (!acceptedLeaves.has(leaf)) return false;
      }
      return true;
    },
    countLodMappedIndices(nodes) {
      counters.count++;
      return nodes.length;
    },
    writeLodMappedIndices(nodes, _lodLevel, target) {
      counters.write++;
      const visibleRanks = new Set(
        nodes.map(node => node.rank),
      );
      let writeOffset = 0;
      for (
        let compactRank = 0;
        compactRank < level.pointCount;
        compactRank++
      ) {
        if (visibleRanks.has(compactRank)) {
          target[writeOffset++] = compactRank;
        }
      }
      return writeOffset;
    },
    lodLevels: [level],
    root: {},
    validatePointCount() {
      return { valid: true };
    },
  };
}

function makeHarness(admissionSequence) {
  const counters = {
    collects: 0,
    count: 0,
    draws: 0,
    uploads: 0,
    write: 0,
  };
  const gl = {
    ELEMENT_ARRAY_BUFFER: 0x8893,
    POINTS: 0,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    UNSIGNED_INT: 0x1405,
    activeTexture() {},
    bindBuffer() {},
    bindTexture() {},
    bindVertexArray() {},
    drawElements() {
      counters.draws++;
    },
    uniform1f() {},
    uniform1i() {},
    uniform3fv() {},
    uniformMatrix4fv() {},
    useProgram() {},
  };
  const uniforms = Object.fromEntries(
    UNIFORM_NAMES.map(name => [name, null]),
  );
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _dummyLodIndexTexture: {},
      _lodResourceOwnersByDimension: new Map(),
      _validatedLodNodeMappings: new WeakMap(),
      _validatedSpatialIndices: new WeakSet(),
      activeProgram: {},
      activeQuality: 'full',
      admissionSequence,
      gl,
      pointCount: 3,
      stats: {},
      uniformLocations: new Map([['full', uniforms]]),
      vao: {},
      _bindAlphaTexture() {},
      _collectVisibleNodes(_root, _planes, result) {
        counters.collects++;
        result.push(...this.admissionSequence);
      },
      _updateStats(viewState, update) {
        return HighPerfRenderer.prototype._updateStats.call(
          this,
          viewState,
          update,
        );
      },
      _uploadToViewIndexBuffer(viewState, indices) {
        counters.uploads++;
        viewState.indexBufferSize = indices.length;
        viewState.indexBufferByteLength = indices.byteLength;
      },
    },
  );
  return { counters, renderer };
}

function makeAcceptedViewState(
  owner,
  leaves,
  mappingToken,
  lod,
  snapshot,
) {
  const visibleRanks = new Set(
    leaves.map(leaf => leaf.rank),
  );
  const values = lod
    ? Uint32Array.from(
        owner.lodLevels[0].indices,
        compactRank => compactRank,
      ).filter(compactRank =>
        visibleRanks.has(compactRank)
      ).map(compactRank =>
        snapshot
          ? owner._lodNodeMapping.maximumIndices[
              compactRank
            ]
          : compactRank
      )
    : Uint32Array.from(
        leaves,
        leaf => leaf.indices[0],
      );
  const visibleIndicesBuffer = values.slice();
  const visibleLodIndicesBuffer = values.slice();
  return {
    cachedCulledCount: values.length,
    cachedLodDimension: 2,
    cachedLodIsCulled: lod,
    cachedLodLevel: lod ? 0 : -1,
    cachedLodMappingGeneration:
      lod ? mappingToken : null,
    cachedLodVisibleIndices:
      lod
        ? visibleLodIndicesBuffer.subarray(0, values.length)
        : null,
    cachedVisibleIndices:
      lod
        ? null
        : visibleIndicesBuffer.subarray(0, values.length),
    cachedVisibleNodes: leaves.slice(),
    cachedVisibleSpatialOwner: owner,
    cachedVisibleSpatialRoot: owner.root,
    indexBuffer: {},
    indexBufferByteLength:
      values.byteLength,
    indexBufferSize: values.length,
    lastDimensionLevel: 2,
    lastFrustumMVP: identityMatrix(),
    lastVisibleCount: values.length,
    stats: {
      lastFrameTime: 0,
      fps: 0,
      visiblePoints: 0,
      lodLevel: -1,
      drawCalls: 0,
      frustumCulled: false,
      cullPercent: 0,
    },
    statsPublished: false,
    usePreCachedIndexBuffer: false,
    preCachedGenerationToken: null,
    preCachedIndexBuffer: null,
    preCachedSpatialOwner: null,
    visibleIndicesBuffer,
    visibleIndicesCapacity:
      visibleIndicesBuffer.length,
    visibleLodIndicesBuffer,
    visibleLodIndicesCapacity:
      visibleLodIndicesBuffer.length,
    visibleNodesScratch: [],
    visibleNodesSpare: [],
  };
}

const CASES = [
  {
    label: 'live full-detail',
    lod: false,
    snapshot: false,
  },
  {
    label: 'snapshot full-detail',
    lod: false,
    snapshot: true,
  },
  {
    label: 'live LOD',
    lod: true,
    snapshot: false,
  },
  {
    label: 'snapshot LOD',
    lod: true,
    snapshot: true,
  },
];

function renderCase(
  testCase,
  renderer,
  owner,
  viewState,
  matrix,
) {
  const params = makeParams(
    testCase.label.replaceAll(' ', '-'),
    matrix,
  );
  const lodBuffers = owner.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  let frustumChanged =
    !ArrayBuffer.isView(viewState.lastFrustumMVP) ||
    viewState.lastFrustumMVP.length !== 16;
  if (!frustumChanged) {
    for (let index = 0; index < 16; index++) {
      if (viewState.lastFrustumMVP[index] !== matrix[index]) {
        frustumChanged = true;
        break;
      }
    }
  }
  if (frustumChanged) {
    viewState.lastFrustumMVP = matrix.slice();
  }
  if (!testCase.snapshot && !testCase.lod) {
    renderer._renderWithFrustumCulling(
      params,
      [],
      viewState,
      owner,
      frustumChanged,
    );
    return;
  }
  if (testCase.snapshot && !testCase.lod) {
    renderer._renderSnapshotWithFrustumCulling(
      makeSnapshot(),
      params,
      [],
      viewState,
      1,
      false,
      owner,
      frustumChanged,
    );
    return;
  }
  if (!testCase.snapshot) {
    renderer._renderLODWithFrustumCulling(
      0,
      params,
      [],
      viewState,
      owner,
      lodBuffers,
      frustumChanged,
    );
    return;
  }
  renderer._renderSnapshotLODWithFrustumCulling(
    makeSnapshot(),
    0,
    params,
    [],
    viewState,
    false,
    owner,
    lodBuffers,
    frustumChanged,
  );
}

function withOneFailedUint32Allocation(
  expectedLength,
  callback,
) {
  const NativeUint32Array = globalThis.Uint32Array;
  let failureInjected = false;
  const HostileUint32Array = new Proxy(
    NativeUint32Array,
    {
      construct(target, argumentsList) {
        if (
          !failureInjected &&
          argumentsList[0] === expectedLength
        ) {
          failureInjected = true;
          throw new RangeError(
            'synthetic visible-index host allocation failure',
          );
        }
        return Reflect.construct(
          target,
          argumentsList,
          target,
        );
      },
    },
  );
  globalThis.Uint32Array = HostileUint32Array;
  let callbackError = null;
  try {
    callback();
  } catch (error) {
    callbackError = error;
  } finally {
    globalThis.Uint32Array = NativeUint32Array;
  }
  assert.equal(
    failureInjected,
    true,
    'the exact full-detail scratch allocation must be reached',
  );
  if (callbackError !== null) throw callbackError;
}

for (const testCase of CASES) {
  test(`${testCase.label} reuses an accepted EBO only for the exact ${testCase.lod ? 'leaf-set' : 'ordered leaf'} contract`, () => {
    const leafA = makeLeaf(0);
    const leafB = makeLeaf(1);
    const admissionSequence = [leafA, leafB];
    const { counters, renderer } =
      makeHarness(admissionSequence);
    const generationToken = Object.freeze({});
    const owner =
      makeSpatialOwner(counters, generationToken);
    const viewState = makeAcceptedViewState(
      owner,
      admissionSequence,
      generationToken,
      testCase.lod,
      testCase.snapshot,
    );
    const acceptedNodes = viewState.cachedVisibleNodes;
    const acceptedCpuView = testCase.lod
      ? viewState.cachedLodVisibleIndices
      : viewState.cachedVisibleIndices;
    const acceptedCpuBuffer = testCase.lod
      ? viewState.visibleLodIndicesBuffer
      : viewState.visibleIndicesBuffer;
    const candidatePool = viewState.visibleNodesScratch;

    renderCase(
      testCase,
      renderer,
      owner,
      viewState,
      identityMatrix(0.01),
    );

    assert.equal(counters.collects, 1);
    assert.equal(counters.uploads, 0);
    assert.equal(counters.count, 0);
    assert.equal(counters.write, 0);
    assert.equal(
      viewState.stats.frustumCulled,
      true,
    );
    assert.equal(
      viewState.stats.cullPercent,
      100 / 3,
    );
    assert.strictEqual(
      viewState.cachedVisibleNodes,
      acceptedNodes,
      'equivalent traversal must keep the accepted leaf owner',
    );
    assert.strictEqual(
      testCase.lod
        ? viewState.cachedLodVisibleIndices
        : viewState.cachedVisibleIndices,
      acceptedCpuView,
      'equivalent traversal must keep the accepted CPU EBO view',
    );
    assert.strictEqual(
      testCase.lod
        ? viewState.visibleLodIndicesBuffer
        : viewState.visibleIndicesBuffer,
      acceptedCpuBuffer,
      'equivalent traversal must not replace backing scratch',
    );
    assert.strictEqual(
      viewState.visibleNodesScratch,
      candidatePool,
      'the candidate leaf array must return to the same per-view pool',
    );
    assert.equal(candidatePool.length, 0);

    renderer.admissionSequence = [leafB, leafA];
    renderCase(
      testCase,
      renderer,
      owner,
      viewState,
      identityMatrix(0.02),
    );
    assert.equal(counters.collects, 2);
    const uploadsAfterReorder =
      testCase.lod ? 0 : 1;
    assert.equal(
      counters.uploads,
      uploadsAfterReorder,
    );
    assert.equal(counters.count, 0);
    assert.equal(counters.write, 0);
    if (testCase.lod) {
      assert.strictEqual(
        viewState.cachedVisibleNodes,
        acceptedNodes,
        'global compact-rank order makes traversal reordering equivalent',
      );
      assert.strictEqual(
        viewState.cachedLodVisibleIndices,
        acceptedCpuView,
      );
    } else {
      assert.deepEqual(
        viewState.cachedVisibleNodes,
        [leafB, leafA],
        'full-detail EBO order remains leaf-order semantic',
      );
      assert.notStrictEqual(
        viewState.cachedVisibleIndices,
        acceptedCpuView,
      );
    }

    const reorderedCpuView = testCase.lod
      ? viewState.cachedLodVisibleIndices
      : viewState.cachedVisibleIndices;
    const acceptedReorderedNodes =
      viewState.cachedVisibleNodes;
    const reorderedCandidatePool =
      viewState.visibleNodesScratch;
    renderCase(
      testCase,
      renderer,
      owner,
      viewState,
      identityMatrix(0.03),
    );
    assert.equal(counters.collects, 3);
    assert.equal(
      counters.uploads,
      uploadsAfterReorder,
    );
    assert.strictEqual(
      viewState.cachedVisibleNodes,
      acceptedReorderedNodes,
    );
    assert.strictEqual(
      testCase.lod
        ? viewState.cachedLodVisibleIndices
        : viewState.cachedVisibleIndices,
      reorderedCpuView,
    );
    assert.strictEqual(
      viewState.visibleNodesScratch,
      reorderedCandidatePool,
    );

    const replacementLeafB = makeLeaf(1);
    renderer.admissionSequence = [
      replacementLeafB,
      leafA,
    ];
    renderCase(
      testCase,
      renderer,
      owner,
      viewState,
      identityMatrix(0.04),
    );
    const uploadsAfterReplacement =
      testCase.lod ? 1 : 2;
    assert.equal(
      counters.uploads,
      uploadsAfterReplacement,
    );
    assert.strictEqual(
      viewState.cachedVisibleNodes[0],
      replacementLeafB,
      'same-sized leaf replacement must rebuild',
    );

    if (testCase.lod) {
      const replacementGeneration = Object.freeze({});
      owner._lodNodeMapping = {
        generationToken: replacementGeneration,
        maximumIndices: Uint32Array.of(1, 2, 0),
      };
      const collectsBeforeMapping = counters.collects;
      renderCase(
        testCase,
        renderer,
        owner,
        viewState,
        identityMatrix(0.04),
      );
      assert.equal(
        counters.collects,
        collectsBeforeMapping,
        'mapping-only replacement reuses accepted leaves',
      );
      assert.equal(
        counters.uploads,
        uploadsAfterReplacement + 1,
      );
      assert.strictEqual(
        viewState.cachedLodMappingGeneration,
        replacementGeneration,
      );
    }

    const uploadsBeforeMode = counters.uploads;
    if (testCase.lod) {
      viewState.cachedLodIsCulled = false;
      viewState.cachedLodLevel = -1;
    } else {
      viewState.cachedLodIsCulled = true;
      viewState.cachedLodLevel = 0;
    }
    renderCase(
      testCase,
      renderer,
      owner,
      viewState,
      identityMatrix(0.04),
    );
    assert.equal(
      counters.uploads,
      uploadsBeforeMode + 1,
      'full/LOD mode mismatch must rebuild the EBO',
    );

    const replacementOwner = makeSpatialOwner(
      counters,
      Object.freeze({}),
    );
    const uploadsBeforeOwner = counters.uploads;
    renderCase(
      testCase,
      renderer,
      replacementOwner,
      viewState,
      identityMatrix(0.05),
    );
    assert.equal(
      counters.uploads,
      uploadsBeforeOwner + 1,
      'spatial owner/root replacement must rebuild',
    );
    assert.strictEqual(
      viewState.cachedVisibleSpatialOwner,
      replacementOwner,
    );
    assert.strictEqual(
      viewState.cachedVisibleSpatialRoot,
      replacementOwner.root,
    );
  });
}

for (const testCase of CASES.filter(
  candidate => !candidate.lod,
)) {
  test(`${testCase.label} scratch growth preserves its accepted owner and retries after host OOM`, () => {
    const leafA = makeLeaf(0);
    const leafB = makeLeaf(1);
    const acceptedLeaves = [leafA];
    const admissionSequence = [leafA, leafB];
    const { counters, renderer } =
      makeHarness(admissionSequence);
    const token = Object.freeze({});
    const owner = makeSpatialOwner(counters, token);
    const viewState = makeAcceptedViewState(
      owner,
      acceptedLeaves,
      token,
      false,
      testCase.snapshot,
    );
    const acceptedBuffer =
      viewState.visibleIndicesBuffer;
    const acceptedCapacity =
      viewState.visibleIndicesCapacity;
    const moved = identityMatrix(0.125);

    assert.throws(
      () => withOneFailedUint32Allocation(
        3,
        () => renderCase(
          testCase,
          renderer,
          owner,
          viewState,
          moved,
        ),
      ),
      /synthetic visible-index host allocation failure/,
    );
    assert.strictEqual(
      viewState.visibleIndicesBuffer,
      acceptedBuffer,
    );
    assert.equal(
      viewState.visibleIndicesCapacity,
      acceptedCapacity,
    );
    assert.equal(viewState.cachedVisibleIndices, null);
    assert.equal(viewState.indexBufferSize, 0);

    renderCase(
      testCase,
      renderer,
      owner,
      viewState,
      moved,
    );
    assert.equal(counters.uploads, 1);
    assert.deepEqual(
      Array.from(viewState.cachedVisibleIndices),
      [0, 1],
    );
    assert.equal(viewState.visibleIndicesCapacity, 3);
    assert.equal(viewState.visibleIndicesBuffer.length, 3);
  });
}

test('full-detail scratch transactionally sheds a material multiview high-water mark', () => {
  const renderer = Object.create(
    HighPerfRenderer.prototype,
  );
  const acceptedBuffer = new Uint32Array(300_000);
  const viewState = {
    visibleIndicesBuffer: acceptedBuffer,
    visibleIndicesCapacity: acceptedBuffer.length,
  };

  assert.throws(
    () => withOneFailedUint32Allocation(
      150,
      () => renderer._ensureVisibleIndexScratch(
        viewState,
        100,
        false,
      ),
    ),
    /synthetic visible-index host allocation failure/,
  );
  assert.strictEqual(
    viewState.visibleIndicesBuffer,
    acceptedBuffer,
  );
  assert.equal(
    viewState.visibleIndicesCapacity,
    acceptedBuffer.length,
  );

  const replacement =
    renderer._ensureVisibleIndexScratch(
      viewState,
      100,
      false,
    );
  assert.notStrictEqual(replacement, acceptedBuffer);
  assert.equal(replacement.length, 150);
  assert.strictEqual(
    viewState.visibleIndicesBuffer,
    replacement,
  );
  assert.equal(viewState.visibleIndicesCapacity, 150);
});

test('renderer-created views own isolated two-array leaf pools', () => {
  let nextBufferId = 0;
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _perViewState: new Map(),
      gl: {
        createBuffer() {
          nextBufferId++;
          return { id: nextBufferId };
        },
      },
    },
  );

  const viewA = renderer._getViewState('view-a');
  const viewB = renderer._getViewState('view-b');
  assert.notStrictEqual(
    viewA.cachedVisibleNodes,
    viewA.visibleNodesScratch,
  );
  assert.notStrictEqual(
    viewA.cachedVisibleNodes,
    viewB.cachedVisibleNodes,
  );
  assert.notStrictEqual(
    viewA.visibleNodesScratch,
    viewB.visibleNodesScratch,
  );
  assert.notStrictEqual(
    viewA.indexBuffer,
    viewB.indexBuffer,
  );

  const acceptedA = viewA.cachedVisibleNodes;
  const scratchA = viewA.visibleNodesScratch;
  const leaf = makeLeaf(0);
  renderer._collectVisibleNodes = (
    _root,
    _planes,
    result,
  ) => {
    result.push(leaf);
  };
  acceptedA.push(leaf);

  for (let iteration = 0; iteration < 1000; iteration++) {
    const candidate = renderer._collectVisibleNodeCandidate(
      viewA,
      {},
      [],
    );
    assert.equal(
      renderer._hasSameOrderedVisibleNodes(
        acceptedA,
        candidate,
      ),
      true,
    );
    renderer._recycleVisibleNodeCandidate(
      viewA,
      candidate,
    );
    assert.strictEqual(viewA.cachedVisibleNodes, acceptedA);
    assert.strictEqual(viewA.visibleNodesScratch, scratchA);
  }

  assert.deepEqual(viewB.cachedVisibleNodes, []);
  assert.deepEqual(viewB.visibleNodesScratch, []);
});

test('failed candidate traversal invalidates the already-advanced MVP and retries exactly', () => {
  const leaf = makeLeaf(0);
  const admissionSequence = [leaf];
  const { counters, renderer } =
    makeHarness(admissionSequence);
  const token = Object.freeze({});
  const owner = makeSpatialOwner(counters, token);
  const viewState = makeAcceptedViewState(
    owner,
    admissionSequence,
    token,
    false,
    false,
  );
  const moved = identityMatrix(0.125);
  renderer._collectVisibleNodes = () => {
    throw new Error('synthetic traversal failure');
  };

  assert.throws(
    () => renderer._renderWithFrustumCulling(
      makeParams('retry-view', moved),
      [],
      viewState,
      owner,
      true,
    ),
    /synthetic traversal failure/,
  );
  assert.equal(viewState.lastFrustumMVP, null);
  assert.equal(viewState.cachedVisibleNodes, null);
  assert.equal(viewState.indexBufferSize, 0);
  const recoveryCandidate =
    viewState.visibleNodesScratch;
  const recoverySpare =
    viewState.visibleNodesSpare;
  assert.ok(Array.isArray(recoveryCandidate));
  assert.ok(Array.isArray(recoverySpare));
  assert.notStrictEqual(
    recoveryCandidate,
    recoverySpare,
  );

  renderer._collectVisibleNodes = (
    _root,
    _planes,
    result,
  ) => {
    counters.collects++;
    result.push(leaf);
  };
  renderer._renderWithFrustumCulling(
    makeParams('retry-view', moved),
    [],
    viewState,
    owner,
  );
  assert.equal(counters.collects, 1);
  assert.equal(counters.uploads, 1);
  assert.strictEqual(
    viewState.cachedVisibleNodes,
    recoveryCandidate,
  );
  assert.strictEqual(
    viewState.visibleNodesScratch,
    recoverySpare,
  );
  assert.strictEqual(
    viewState.cachedVisibleNodes[0],
    leaf,
  );
  assert.deepEqual(
    viewState.cachedVisibleIndices,
    Uint32Array.of(0),
  );
});

test('viewer render inventory uses stable live and weak snapshot records', async () => {
  const viewerSource = await readFile(
    new URL(
      '../assets/js/rendering/viewer.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    viewerSource,
    /const _liveRenderViewRecord = \{/,
  );
  assert.match(
    viewerSource,
    /const _snapshotRenderViewRecordPool = new WeakMap\(\)/,
  );
  assert.doesNotMatch(
    viewerSource,
    /_renderAllViews\.push\(\s*\{/,
    'the hot render inventory must not allocate one descriptor literal per view per frame',
  );
});

test('stable live render record releases every dataset-sized reference at terminal retirement', () => {
  const colors = new Uint8Array(4_000_000);
  const transparency = new Float32Array(1_000_000);
  const centroidPositions = new Float32Array(300);
  const centroidColors = new Uint8Array(400);
  const centroidTransparencies = new Float32Array(100);
  const cameraState = {
    orbit: {
      radius: 1,
      target: [0, 0, 0],
    },
  };
  const stableRecord = {
    id: 'live',
    label: 'Large live dataset',
    colors,
    transparency,
    centroidPositions,
    centroidColors,
    centroidTransparencies,
    centroidCount: 100,
    cameraState,
  };
  const acceptedIdentity = stableRecord;

  // Publishing new per-frame references mutates the stable descriptor rather
  // than replacing it; retirement must preserve that allocation contract.
  stableRecord.colors = colors;
  stableRecord.transparency = transparency;
  stableRecord.cameraState = cameraState;
  assert.strictEqual(stableRecord, acceptedIdentity);

  const retired =
    retireRenderViewRecord(stableRecord);

  assert.strictEqual(retired, acceptedIdentity);
  assert.equal(retired.id, 'live');
  assert.equal(retired.label, '');
  assert.equal(retired.colors, null);
  assert.equal(retired.transparency, null);
  assert.equal(retired.centroidPositions, null);
  assert.equal(retired.centroidColors, null);
  assert.equal(retired.centroidTransparencies, null);
  assert.equal(retired.centroidCount, 0);
  assert.equal(retired.cameraState, null);
});
