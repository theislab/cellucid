// assets/js/app/ui/modules/benchmark/generation-contract.js
var SYNTHETIC_PATTERNS = Object.freeze([
  "atlas",
  "batches",
  "clusters",
  "flatumap",
  "glb",
  "octopus",
  "spirals",
  "uniform"
]);
var FETCHED_PATTERNS = Object.freeze(["glb"]);
var MIN_SYNTHETIC_COUNT = 1;
var MAX_SYNTHETIC_COUNT = 25e7;
function assertSyntheticPattern(pattern) {
  if (!SYNTHETIC_PATTERNS.includes(pattern)) {
    throw new RangeError(
      `Synthetic pattern must be one of ${SYNTHETIC_PATTERNS.join(", ")}; received ${String(pattern)}.`
    );
  }
  return pattern;
}
function assertSyntheticCount(count) {
  if (!Number.isSafeInteger(count) || count < MIN_SYNTHETIC_COUNT || count > MAX_SYNTHETIC_COUNT) {
    throw new TypeError(
      `Synthetic point count must be one integer between ${MIN_SYNTHETIC_COUNT} and ${MAX_SYNTHETIC_COUNT}; received ${String(count)}.`
    );
  }
  return count;
}
function assertGenerationRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Generation request must be one plain object.");
  }
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) {
    throw new TypeError(
      "Generation request id must be one non-negative safe integer."
    );
  }
  const pattern = assertSyntheticPattern(request.pattern);
  const count = assertSyntheticCount(request.count);
  const sourceUrl = request.sourceUrl ?? null;
  if (FETCHED_PATTERNS.includes(pattern)) {
    if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
      throw new TypeError(
        `Generation pattern "${pattern}" requires one absolute sourceUrl; a worker cannot resolve a document-relative one.`
      );
    }
  } else if (sourceUrl !== null) {
    throw new TypeError(
      `Generation pattern "${pattern}" is computed and takes no sourceUrl.`
    );
  }
  return Object.freeze({ requestId: request.requestId, pattern, count, sourceUrl });
}

// assets/js/app/ui/place-names.js
function place(name, where) {
  return Object.freeze({ name, ...where });
}
var PLACES = Object.freeze({
  // Panels.
  session: place("Session", { panel: "session-section" }),
  visualization: place("Visualization", { panel: "visualization-section" }),
  navigation: place("Navigation", { panel: "navigation-section" }),
  compareViews: place("Compare views", { panel: "compare-views-section" }),
  coloringFiltering: place("Coloring & filtering", { panel: "coloring-filtering-section" }),
  highlighting: place("Highlighting", { panel: "highlighted-cells-section" }),
  benchmark: place("Benchmark", { panel: "benchmark-section" }),
  // Blocks of the Session panel.
  dataset: place("Dataset", { heading: "dataset-facts-title" }),
  dataMapping: place("Data mapping", { heading: "data-mapping-title" }),
  sessionFile: place("Session file", { heading: "session-state-title" }),
  // Blocks of the Visualization panel.
  performance: place("Performance", { heading: "renderer-settings-title" }),
  vectorField: place("Vector field", { heading: "vector-field-title" }),
  // Places the page builds itself, headed with these names: the legend's
  // range of a continuous field (`legend-renderer.js`), the community
  // annotation panel's columns (`community-annotation/controls-panel.js`).
  visibleRange: place("Visible range", {}),
  annotatedColumns: place("Annotated columns", {})
});

// assets/js/utils/format-units.js
var BYTE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
var GROUPED_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}
function requireCount(value) {
  if (typeof value === "bigint") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Count must be a finite number");
  }
}
function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}
function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== "string" || singular.length === 0) {
    throw new TypeError("A counted noun must be non-empty text");
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

// assets/js/dev/benchmark.js
var glbBufferPromises = /* @__PURE__ */ new Map();
var MEBIBYTE = 1024 * 1024;
function requireSyntheticPointCount(count) {
  if (!Number.isSafeInteger(count) || count < MIN_SYNTHETIC_COUNT || count > MAX_SYNTHETIC_COUNT) {
    throw new RangeError(
      `Synthetic point count must be one integer between ${MIN_SYNTHETIC_COUNT} and ${MAX_SYNTHETIC_COUNT}; received ${String(count)}.`
    );
  }
  return count;
}
function hueToRgbChannel(p, q, rawT) {
  let t = rawT;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function normalizedByte(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}
var DEFAULT_SYNTHETIC_SEED = 6221086;
function createSeededUnitStream(seed) {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError("Synthetic generation seed must be one safe integer.");
  }
  let state = seed >>> 0;
  return function nextUnit() {
    state = state + 2654435769 >>> 0;
    let z = state;
    z = Math.imul(z ^ z >>> 16, 569420461) >>> 0;
    z = Math.imul(z ^ z >>> 15, 1935289751) >>> 0;
    z = (z ^ z >>> 15) >>> 0;
    return z / 4294967296;
  };
}
var activeSyntheticSeed = DEFAULT_SYNTHETIC_SEED;
var syntheticUnitRandom = createSeededUnitStream(activeSyntheticSeed);
function restartSyntheticStream() {
  syntheticUnitRandom = createSeededUnitStream(activeSyntheticSeed);
}
var GLBParser = class {
  /**
   * Parse a GLB file and extract mesh data
   * @param {ArrayBuffer} buffer - The GLB file data
   * @returns {Object} - { positions: Float32Array, indices: Uint32Array, normals?: Float32Array }
   */
  static parse(buffer) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 1179937895) {
      throw new Error("Invalid GLB magic number");
    }
    const version = view.getUint32(4, true);
    if (version !== 2) {
      throw new Error(`Unsupported GLB version: ${version}`);
    }
    let offset = 12;
    let jsonChunk = null;
    let binChunk = null;
    while (offset < buffer.byteLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const chunkData = buffer.slice(offset + 8, offset + 8 + chunkLength);
      if (chunkType === 1313821514) {
        const decoder = new TextDecoder("utf-8");
        jsonChunk = JSON.parse(decoder.decode(chunkData));
      } else if (chunkType === 5130562) {
        binChunk = chunkData;
      }
      offset += 8 + chunkLength;
    }
    if (!jsonChunk || !binChunk) {
      throw new Error("GLB missing JSON or BIN chunk");
    }
    return this._extractMeshData(jsonChunk, binChunk);
  }
  static _extractMeshData(gltf, binBuffer) {
    const accessors = gltf.accessors;
    const bufferViews = gltf.bufferViews;
    const copyToAligned = (srcBuffer, byteOffset, byteLength, TypedArrayClass) => {
      const srcView = new Uint8Array(srcBuffer, byteOffset, byteLength);
      const alignedBuffer = new ArrayBuffer(byteLength);
      new Uint8Array(alignedBuffer).set(srcView);
      return new TypedArrayClass(alignedBuffer);
    };
    const allPositions = [];
    const allIndices = [];
    let vertexOffset = 0;
    for (const mesh of gltf.meshes || []) {
      for (const primitive of mesh.primitives || []) {
        const posAccessorIdx = primitive.attributes?.POSITION;
        if (posAccessorIdx === void 0) continue;
        const posAccessor = accessors[posAccessorIdx];
        const posView = bufferViews[posAccessor.bufferView];
        const posOffset = (posView.byteOffset || 0) + (posAccessor.byteOffset || 0);
        const posByteLength = posAccessor.count * 3 * 4;
        const positions2 = copyToAligned(binBuffer, posOffset, posByteLength, Float32Array);
        allPositions.push(positions2);
        if (primitive.indices !== void 0) {
          const idxAccessor = accessors[primitive.indices];
          const idxView = bufferViews[idxAccessor.bufferView];
          const idxOffset = (idxView.byteOffset || 0) + (idxAccessor.byteOffset || 0);
          let indices2;
          if (idxAccessor.componentType === 5123) {
            const idxByteLength = idxAccessor.count * 2;
            const shortIndices = copyToAligned(binBuffer, idxOffset, idxByteLength, Uint16Array);
            indices2 = new Uint32Array(shortIndices);
          } else if (idxAccessor.componentType === 5125) {
            const idxByteLength = idxAccessor.count * 4;
            indices2 = copyToAligned(binBuffer, idxOffset, idxByteLength, Uint32Array);
          } else if (idxAccessor.componentType === 5121) {
            const byteIndices = new Uint8Array(binBuffer, idxOffset, idxAccessor.count);
            indices2 = new Uint32Array(byteIndices);
          }
          if (indices2) {
            const offsetIndices = new Uint32Array(indices2.length);
            for (let i = 0; i < indices2.length; i++) {
              offsetIndices[i] = indices2[i] + vertexOffset;
            }
            allIndices.push(offsetIndices);
          }
        }
        vertexOffset += posAccessor.count;
      }
    }
    if (allPositions.length === 0) {
      throw new Error("No meshes with positions found in GLB");
    }
    const totalVertices = allPositions.reduce((sum, p) => sum + p.length, 0);
    const positions = new Float32Array(totalVertices);
    let offset = 0;
    for (const p of allPositions) {
      positions.set(p, offset);
      offset += p.length;
    }
    let indices = null;
    if (allIndices.length > 0) {
      const totalIndices = allIndices.reduce((sum, i) => sum + i.length, 0);
      indices = new Uint32Array(totalIndices);
      offset = 0;
      for (const i of allIndices) {
        indices.set(i, offset);
        offset += i.length;
      }
    }
    console.log(`[GLBParser] Merged ${allPositions.length} primitives: ${formatCountOf(positions.length / 3, "vertex", "vertices")}, ${formatCountOf(indices ? indices.length / 3 : 0, "triangle")}`);
    return { positions, indices, normals: null };
  }
};
var MeshSurfaceSampler = class {
  /**
   * @param {Float32Array} positions - XYZ vertices.
   * @param {Uint8Array|Uint16Array|Uint32Array|null} indices - Triangle indices.
   * @param {(() => number)|null} [unitRandom] - Unit-interval source. Defaults
   *   to the module's seeded generation stream, so a sampler built during a
   *   generator call inherits that call's determinism.
   */
  constructor(positions, indices, unitRandom = null) {
    if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 !== 0) {
      throw new TypeError(
        "Mesh surface positions must be non-empty Float32 XYZ vertices."
      );
    }
    if (indices !== null && !(indices instanceof Uint8Array || indices instanceof Uint16Array || indices instanceof Uint32Array)) {
      throw new TypeError(
        "Mesh surface indices must be null or an unsigned integer array."
      );
    }
    if (indices !== null && (indices.length < 3 || indices.length % 3 !== 0)) {
      throw new TypeError(
        "Mesh surface indices must contain complete triangles."
      );
    }
    if (indices === null && positions.length % 9 !== 0) {
      throw new TypeError(
        "A non-indexed mesh must contain complete triangle vertices."
      );
    }
    if (unitRandom !== null && typeof unitRandom !== "function") {
      throw new TypeError(
        "Mesh surface unit-random source must be null or a function."
      );
    }
    this.positions = positions;
    this.indices = indices;
    this._unitRandom = unitRandom;
    this.triangleCount = indices ? indices.length / 3 : positions.length / 9;
    this.areas = new Float64Array(this.triangleCount);
    this.cumulativeAreas = new Float64Array(this.triangleCount);
    this.triangleData = new Float32Array(this.triangleCount * 12);
    this.totalArea = 0;
    this._computeAreas();
  }
  _computeAreas() {
    const positions = this.positions;
    const indices = this.indices;
    const vertexCount = positions.length / 3;
    for (let i = 0; i < this.triangleCount; i++) {
      const triangleOffset = i * 3;
      const i0 = indices === null ? triangleOffset : indices[triangleOffset];
      const i1 = indices === null ? triangleOffset + 1 : indices[triangleOffset + 1];
      const i2 = indices === null ? triangleOffset + 2 : indices[triangleOffset + 2];
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) {
        throw new RangeError(
          `Mesh triangle ${i} references a vertex outside the mesh.`
        );
      }
      const v0Offset = i0 * 3;
      const v1Offset = i1 * 3;
      const v2Offset = i2 * 3;
      const x0 = positions[v0Offset];
      const y0 = positions[v0Offset + 1];
      const z0 = positions[v0Offset + 2];
      const ax = positions[v1Offset] - x0;
      const ay = positions[v1Offset + 1] - y0;
      const az = positions[v1Offset + 2] - z0;
      const bx = positions[v2Offset] - x0;
      const by = positions[v2Offset + 1] - y0;
      const bz = positions[v2Offset + 2] - z0;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const crossLength = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const area = 0.5 * crossLength;
      if (!Number.isFinite(area)) {
        throw new RangeError(
          `Mesh triangle ${i} has non-finite geometry.`
        );
      }
      const dataOffset = i * 12;
      this.triangleData[dataOffset] = x0;
      this.triangleData[dataOffset + 1] = y0;
      this.triangleData[dataOffset + 2] = z0;
      this.triangleData[dataOffset + 3] = ax;
      this.triangleData[dataOffset + 4] = ay;
      this.triangleData[dataOffset + 5] = az;
      this.triangleData[dataOffset + 6] = bx;
      this.triangleData[dataOffset + 7] = by;
      this.triangleData[dataOffset + 8] = bz;
      if (crossLength > 0) {
        this.triangleData[dataOffset + 9] = cx / crossLength;
        this.triangleData[dataOffset + 10] = cy / crossLength;
        this.triangleData[dataOffset + 11] = cz / crossLength;
      }
      this.areas[i] = area;
      this.totalArea += area;
      this.cumulativeAreas[i] = this.totalArea;
    }
    if (!Number.isFinite(this.totalArea) || this.totalArea <= 0) {
      throw new RangeError(
        "Mesh surface must contain at least one finite non-degenerate triangle."
      );
    }
  }
  /**
   * Binary search to find triangle index
   */
  _binarySearchTriangle(r) {
    let lo = 0, hi = this.triangleCount - 1;
    while (lo < hi) {
      const mid = lo + hi >>> 1;
      if (this.cumulativeAreas[mid] <= r) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
  /**
   * Internal allocation-free sample used by the tens-of-millions generator.
   */
  _sampleIntoUnchecked(positionTarget, positionOffset, normalTarget, normalOffset) {
    const nextUnit = this._unitRandom === null ? syntheticUnitRandom : this._unitRandom;
    const r = nextUnit() * this.totalArea;
    const triIdx = this._binarySearchTriangle(r);
    const dataOffset = triIdx * 12;
    let u = nextUnit();
    let v = nextUnit();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const triangleData = this.triangleData;
    positionTarget[positionOffset] = triangleData[dataOffset] + u * triangleData[dataOffset + 3] + v * triangleData[dataOffset + 6];
    positionTarget[positionOffset + 1] = triangleData[dataOffset + 1] + u * triangleData[dataOffset + 4] + v * triangleData[dataOffset + 7];
    positionTarget[positionOffset + 2] = triangleData[dataOffset + 2] + u * triangleData[dataOffset + 5] + v * triangleData[dataOffset + 8];
    normalTarget[normalOffset] = triangleData[dataOffset + 9];
    normalTarget[normalOffset + 1] = triangleData[dataOffset + 10];
    normalTarget[normalOffset + 2] = triangleData[dataOffset + 11];
  }
  /**
   * Sample into caller-owned buffers.
   *
   * @param {Float32Array|Float64Array} positionTarget
   * @param {number} positionOffset
   * @param {Float32Array|Float64Array} normalTarget
   * @param {number} normalOffset
   */
  sampleInto(positionTarget, positionOffset, normalTarget, normalOffset = 0) {
    if (!(positionTarget instanceof Float32Array || positionTarget instanceof Float64Array) || !(normalTarget instanceof Float32Array || normalTarget instanceof Float64Array)) {
      throw new TypeError(
        "Mesh samples require floating-point position and normal targets."
      );
    }
    if (!Number.isSafeInteger(positionOffset) || positionOffset < 0 || positionOffset + 3 > positionTarget.length || !Number.isSafeInteger(normalOffset) || normalOffset < 0 || normalOffset + 3 > normalTarget.length) {
      throw new RangeError(
        "Mesh sample target offsets must own three writable values."
      );
    }
    this._sampleIntoUnchecked(
      positionTarget,
      positionOffset,
      normalTarget,
      normalOffset
    );
  }
  /**
   * Sample a random point on the mesh surface.
   *
   * @returns {{position: number[], normal: number[]}}
   */
  sample() {
    const position = new Float64Array(3);
    const normal = new Float64Array(3);
    this._sampleIntoUnchecked(position, 0, normal, 0);
    return {
      position: Array.from(position),
      normal: Array.from(normal)
    };
  }
};
var SyntheticDataGenerator = class {
  /**
   * The seed the next generator call will restart from.
   *
   * @returns {number} Active seed.
   */
  static get seed() {
    return activeSyntheticSeed;
  }
  /**
   * Vary the dataset deliberately. Comparing two runs is only meaningful when
   * they share a seed, so this is the single place a run declares that it
   * wants a different point cloud rather than getting one by accident.
   *
   * @param {number} seed - Safe-integer seed.
   * @returns {number} The accepted seed.
   */
  static setSeed(seed) {
    if (!Number.isSafeInteger(seed)) {
      throw new TypeError("Synthetic generation seed must be one safe integer.");
    }
    activeSyntheticSeed = seed;
    restartSyntheticStream();
    return activeSyntheticSeed;
  }
  /**
   * Generate octopus-like structure with body and tentacles
   */
  static octopus(count, numTentacles = 10) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    console.log(`Generating ${formatCountOf(count, "point")} (octopus with ${numTentacles} tentacles)...`);
    const startTime = performance.now();
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const bodyRadius = 0.36;
    const bodyCenter = [0, 0.28, 0];
    const bodyFreq = 0.4;
    const bodyHotspots = Array.from({ length: 5 }, () => ({
      theta: syntheticUnitRandom() * Math.PI * 2,
      phi: Math.PI * 0.5 + (syntheticUnitRandom() - 0.5) * 0.4,
      boost: 0.4 + syntheticUnitRandom() * 0.7
    }));
    const tentacleLength = 1.1;
    const tentacleThickness = 0.055;
    const tentacleWave = 0.18;
    const tentacleFreq = (1 - bodyFreq) / numTentacles;
    const bodyColor = [0.9, 0.4, 0.3];
    const tentacles = [];
    for (let t = 0; t < numTentacles; t++) {
      const baseAngle = t / numTentacles * Math.PI * 2 + (syntheticUnitRandom() - 0.5) * 0.28;
      const tiltAngle = Math.PI * 0.58 + (syntheticUnitRandom() - 0.5) * 0.32;
      const hue = 0.02 + t * 0.015;
      const wrapTurns = 2.5 + syntheticUnitRandom() * 2.5;
      const wrapRadius = 0.35 + syntheticUnitRandom() * 0.35;
      const wrapPhase = syntheticUnitRandom() * Math.PI * 2;
      const wobblePhase = syntheticUnitRandom() * Math.PI * 2;
      const suctionBands = 3 + Math.floor(syntheticUnitRandom() * 4);
      tentacles.push({ baseAngle, tiltAngle, hue, wrapTurns, wrapRadius, wrapPhase, wobblePhase, suctionBands });
    }
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const r = syntheticUnitRandom();
      if (r < bodyFreq) {
        const hotspot = bodyHotspots[Math.floor(syntheticUnitRandom() * bodyHotspots.length)];
        const useHotspot = syntheticUnitRandom() < 0.65;
        const theta = useHotspot ? hotspot.theta + (syntheticUnitRandom() - 0.5) * 0.35 : syntheticUnitRandom() * Math.PI * 2;
        const phi = useHotspot ? hotspot.phi + (syntheticUnitRandom() - 0.5) * 0.35 : Math.acos(2 * syntheticUnitRandom() - 1);
        const radiusScale = useHotspot ? hotspot.boost : 1;
        const radius = bodyRadius * (0.3 + Math.pow(syntheticUnitRandom(), useHotspot ? 1.35 : 1.8) * 0.9) * radiusScale;
        positions[idx] = bodyCenter[0] + radius * Math.sin(phi) * Math.cos(theta) * 1.35;
        positions[idx + 1] = bodyCenter[1] + radius * Math.cos(phi) * 0.9;
        positions[idx + 2] = bodyCenter[2] + radius * Math.sin(phi) * Math.sin(theta) * 1.35;
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, bodyColor[0] + (syntheticUnitRandom() - 0.5) * 0.12)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, bodyColor[1] + (syntheticUnitRandom() - 0.5) * 0.12)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, bodyColor[2] + (syntheticUnitRandom() - 0.5) * 0.12)) * 255);
        colors[cidx + 3] = 255;
      } else {
        const tentacleIdx = Math.floor((r - bodyFreq) / tentacleFreq);
        const tent = tentacles[Math.min(tentacleIdx, numTentacles - 1)];
        const t = Math.pow(syntheticUnitRandom(), 1.35);
        const thickness = tentacleThickness * (1.1 - t * 0.5);
        const baseX = bodyCenter[0] + bodyRadius * 0.85 * Math.sin(tent.tiltAngle) * Math.cos(tent.baseAngle);
        const baseY = bodyCenter[1] - bodyRadius * 0.55 + this._gaussianRandom() * 0.015;
        const baseZ = bodyCenter[2] + bodyRadius * 0.85 * Math.sin(tent.tiltAngle) * Math.sin(tent.baseAngle);
        const wave1 = Math.sin(t * Math.PI * 4 + tent.wobblePhase) * tentacleWave * t * 1.2;
        const wave2 = Math.cos(t * Math.PI * 3.5 + tent.wobblePhase * 0.8) * tentacleWave * t;
        const wrapAngle = tent.wrapPhase + t * tent.wrapTurns * Math.PI * 2;
        const wrapR = tent.wrapRadius * (1 - t * 0.35);
        const swirlX = Math.cos(wrapAngle) * wrapR;
        const swirlZ = Math.sin(wrapAngle) * wrapR;
        const bend = Math.sin(t * Math.PI * tent.suctionBands) * 0.25;
        const tentX = baseX + t * tentacleLength * Math.sin(tent.tiltAngle + bend * 0.35) * Math.cos(tent.baseAngle + bend) + wave1 + swirlX;
        const tentY = baseY - t * tentacleLength * (0.95 - 0.25 * t) + Math.sin(t * Math.PI * 2) * 0.05;
        const tentZ = baseZ + t * tentacleLength * Math.sin(tent.tiltAngle + bend * 0.35) * Math.sin(tent.baseAngle + bend) + wave2 + swirlZ;
        const thickAngle = syntheticUnitRandom() * Math.PI * 2;
        const ring = (Math.sin(t * tent.suctionBands * Math.PI * 2 + tent.wobblePhase) + 1) * 0.5;
        const thickR = Math.sqrt(syntheticUnitRandom()) * thickness * (1 + ring * 0.65);
        positions[idx] = tentX + thickR * Math.cos(thickAngle);
        positions[idx + 1] = tentY + thickR * Math.sin(thickAngle) * 0.6;
        positions[idx + 2] = tentZ + thickR * Math.sin(thickAngle);
        const tentColor = this._hslToRgb(tent.hue, 0.72, 0.48 - t * 0.22 + ring * 0.08);
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, tentColor[0] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, tentColor[1] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, tentColor[2] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
        colors[cidx + 3] = 255;
      }
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate 3D spiral/helix structures
   */
  static spirals(count, numSpirals = 7) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    console.log(`Generating ${formatCountOf(count, "point")} (${numSpirals} spirals)...`);
    const startTime = performance.now();
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const spiralConfigs = [];
    const globalBraidPhase = syntheticUnitRandom() * Math.PI * 2;
    for (let s = 0; s < numSpirals; s++) {
      spiralConfigs.push({
        // Starting position
        startX: (syntheticUnitRandom() - 0.5) * 0.8,
        startY: (syntheticUnitRandom() - 0.5) * 0.8,
        startZ: (syntheticUnitRandom() - 0.5) * 0.8,
        // Direction (normalized)
        dirTheta: syntheticUnitRandom() * Math.PI * 2,
        dirPhi: Math.PI * 0.35 + syntheticUnitRandom() * Math.PI * 0.6,
        // Spiral parameters
        radius: 0.18 + syntheticUnitRandom() * 0.18,
        length: 0.9 + syntheticUnitRandom() * 1.1,
        turns: 4 + syntheticUnitRandom() * 4,
        thickness: 0.035 + syntheticUnitRandom() * 0.035,
        // Color
        hue: s / Math.max(1, numSpirals - 1),
        // Taper
        taper: syntheticUnitRandom() < 0.65,
        orbitRadius: 0.25 + syntheticUnitRandom() * 0.25,
        orbitTurns: 2 + syntheticUnitRandom() * 3,
        strandCount: 2 + Math.floor(syntheticUnitRandom() * 3),
        kink: 0.06 + syntheticUnitRandom() * 0.08,
        noiseFreq: 2 + syntheticUnitRandom() * 4,
        orbitPhase: globalBraidPhase + (syntheticUnitRandom() - 0.5) * Math.PI
      });
    }
    const pointsPerSpiral = Math.max(1, Math.floor(count / numSpirals));
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const spiralIdx = Math.min(Math.floor(i / pointsPerSpiral), numSpirals - 1);
      const sp = spiralConfigs[spiralIdx];
      const t = Math.pow(syntheticUnitRandom(), 1.25);
      const dirX = Math.sin(sp.dirPhi) * Math.cos(sp.dirTheta);
      const dirY = Math.cos(sp.dirPhi);
      const dirZ = Math.sin(sp.dirPhi) * Math.sin(sp.dirTheta);
      const perpX = -Math.sin(sp.dirTheta);
      const perpZ = Math.cos(sp.dirTheta);
      const perp2X = -Math.cos(sp.dirPhi) * Math.cos(sp.dirTheta);
      const perp2Y = Math.sin(sp.dirPhi);
      const perp2Z = -Math.cos(sp.dirPhi) * Math.sin(sp.dirTheta);
      const orbitAngle = sp.orbitPhase + t * sp.orbitTurns * Math.PI * 2;
      const orbitR = sp.orbitRadius * (1 - t * 0.3);
      const strandPhase = Math.floor(syntheticUnitRandom() * sp.strandCount) / sp.strandCount * Math.PI * 2;
      const wobble = Math.sin(t * sp.noiseFreq * Math.PI * 2 + sp.orbitPhase) * sp.kink + Math.cos(t * sp.noiseFreq * Math.PI + sp.orbitPhase * 0.5) * sp.kink * 0.5;
      const angle = t * sp.turns * Math.PI * 2 + strandPhase + wobble;
      const radius = sp.taper ? sp.radius * (1 - t * 0.6) : sp.radius;
      const spiralX = sp.startX + t * sp.length * dirX + radius * (Math.cos(angle) * perpX + Math.sin(angle) * perp2X);
      const spiralY = sp.startY + t * sp.length * dirY + radius * (Math.sin(angle) * perp2Y + Math.cos(angle) * 0.05);
      const spiralZ = sp.startZ + t * sp.length * dirZ + radius * (Math.cos(angle) * perpZ + Math.sin(angle) * perp2Z);
      const braidedX = spiralX + Math.cos(orbitAngle) * orbitR;
      const braidedY = spiralY + Math.sin(orbitAngle * 0.5) * sp.kink * 0.8;
      const braidedZ = spiralZ + Math.sin(orbitAngle) * orbitR;
      const thick = sp.thickness * (1.25 - t * 0.35);
      positions[idx] = braidedX + this._gaussianRandom() * thick;
      positions[idx + 1] = braidedY + this._gaussianRandom() * thick * 0.9;
      positions[idx + 2] = braidedZ + this._gaussianRandom() * thick;
      const band = (Math.sin(angle * 0.5 + sp.orbitPhase) + 1) * 0.12;
      const color = this._hslToRgb((sp.hue + t * 0.12 + band * 0.1) % 1, 0.78, 0.42 + t * 0.18 + band * 0.15);
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, color[0] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, color[1] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, color[2] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate 2D UMAP-like flat structure with clusters
   */
  static flatUMAP(count, numClusters = 25) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    console.log(`Generating ${formatCountOf(count, "point")} (2D UMAP, ${formatCountOf(numClusters, "cluster")})...`);
    const startTime = performance.now();
    const positions = new Float32Array(count * 2);
    const colors = new Uint8Array(count * 4);
    const clusters = [];
    for (let c = 0; c < numClusters; c++) {
      let cx, cy, attempts = 0;
      do {
        cx = (syntheticUnitRandom() - 0.5) * 1.8;
        cy = (syntheticUnitRandom() - 0.5) * 1.8;
        attempts++;
      } while (attempts < 50 && clusters.some(
        (cl) => Math.hypot(cl.center[0] - cx, cl.center[1] - cy) < 0.2
      ));
      const isElongated = syntheticUnitRandom() < 0.4;
      const angle = syntheticUnitRandom() * Math.PI;
      clusters.push({
        center: [cx, cy],
        spread: 0.04 + syntheticUnitRandom() * 0.08,
        elongation: isElongated ? [1.5 + syntheticUnitRandom(), 0.4 + syntheticUnitRandom() * 0.3] : [1, 1],
        angle,
        color: this._hslToRgb(c / numClusters, 0.7, 0.5),
        weight: 0.5 + syntheticUnitRandom() * 1.5
      });
    }
    const numBridges = Math.floor(numClusters * 0.2);
    for (let b = 0; b < numBridges; b++) {
      const c1 = clusters[Math.floor(syntheticUnitRandom() * numClusters)];
      const c2 = clusters[Math.floor(syntheticUnitRandom() * numClusters)];
      if (c1 !== c2) {
        clusters.push({
          center: [(c1.center[0] + c2.center[0]) / 2, (c1.center[1] + c2.center[1]) / 2],
          spread: 0.02,
          isBridge: true,
          bridgeFrom: c1.center,
          bridgeTo: c2.center,
          color: [
            (c1.color[0] + c2.color[0]) / 2,
            (c1.color[1] + c2.color[1]) / 2,
            (c1.color[2] + c2.color[2]) / 2
          ],
          weight: 0.2
        });
      }
    }
    const totalWeight = clusters.reduce((s, c) => s + c.weight, 0);
    clusters.forEach((c) => c.weight /= totalWeight);
    let cumulative = 0;
    const cumDist = clusters.map((c) => {
      cumulative += c.weight;
      return cumulative;
    });
    for (let i = 0; i < count; i++) {
      const idx = i * 2;
      const r = syntheticUnitRandom();
      let clusterIdx = cumDist.findIndex((c) => r <= c);
      if (clusterIdx < 0) clusterIdx = clusters.length - 1;
      const cluster = clusters[clusterIdx];
      let x, y;
      if (cluster.isBridge) {
        const t = syntheticUnitRandom();
        x = cluster.bridgeFrom[0] + t * (cluster.bridgeTo[0] - cluster.bridgeFrom[0]);
        y = cluster.bridgeFrom[1] + t * (cluster.bridgeTo[1] - cluster.bridgeFrom[1]);
        x += this._gaussianRandom() * cluster.spread;
        y += this._gaussianRandom() * cluster.spread;
      } else {
        let dx = this._gaussianRandom() * cluster.spread * cluster.elongation[0];
        let dy = this._gaussianRandom() * cluster.spread * cluster.elongation[1];
        const cos = Math.cos(cluster.angle);
        const sin = Math.sin(cluster.angle);
        x = cluster.center[0] + dx * cos - dy * sin;
        y = cluster.center[1] + dx * sin + dy * cos;
      }
      positions[idx] = x;
      positions[idx + 1] = y;
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, cluster.color[0] + (syntheticUnitRandom() - 0.5) * 0.06)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, cluster.color[1] + (syntheticUnitRandom() - 0.5) * 0.06)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, cluster.color[2] + (syntheticUnitRandom() - 0.5) * 0.06)) * 255);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 2 };
  }
  /**
   * Generate atlas-like data with multiscale clusters, bridges, and batches.
   * Designed to look closer to real embeddings while stressing LOD/culling.
   */
  static atlasLike(count, options = {}) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    const {
      batches = 3,
      cellTypes = Math.max(16, Math.floor(count / 3500)),
      trajectoryFraction = 0.22,
      rareFraction = 0.05,
      layerDepth = 0.35,
      strongBatchEffects = false,
      label = "Atlas-like (multiscale clusters)"
    } = options;
    console.log(`Generating ${formatCountOf(count, "point")} (${label})...`);
    const startTime = performance.now();
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const safeCellTypes = Math.max(12, Math.min(45, Math.floor(cellTypes)));
    const trajFrac = clamp01(Math.min(0.35, trajectoryFraction));
    const rareFrac = clamp01(Math.min(0.12, rareFraction));
    const anchorFrac = clamp01(1 - trajFrac - rareFrac);
    const goldenAngle = 2.399963229728653;
    const batchOffsets = Array.from({ length: Math.max(1, Math.floor(batches)) }, () => ({
      offset: [
        (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.45 : 0.18),
        (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.35 : 0.14),
        (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.55 : 0.22)
      ],
      tint: (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.18 : 0.08)
    }));
    const anchors = [];
    for (let i = 0; i < safeCellTypes; i++) {
      const angle = i * goldenAngle + (syntheticUnitRandom() - 0.5) * 0.1;
      const radius = 0.25 + syntheticUnitRandom() * 1.15;
      const layer = (i % 3 - 1) * layerDepth * 0.5;
      const center = [
        Math.cos(angle) * radius + (syntheticUnitRandom() - 0.5) * 0.1,
        Math.sin(angle) * radius + (syntheticUnitRandom() - 0.5) * 0.1,
        layer
      ];
      const major = 0.025 + syntheticUnitRandom() * 0.05;
      const minor = major * (0.55 + syntheticUnitRandom() * 0.9);
      const theta = syntheticUnitRandom() * Math.PI;
      const color = this._hslToRgb(i / safeCellTypes, 0.68, 0.52);
      const weight = 0.6 + syntheticUnitRandom() * 1.6;
      anchors.push({
        center,
        spread: [major, minor],
        angle: theta,
        color,
        weight,
        layerOffset: layer + (syntheticUnitRandom() - 0.5) * 0.08,
        sin: Math.sin(theta),
        cos: Math.cos(theta)
      });
    }
    const anchorWeightTotal = anchors.reduce((s, a) => s + a.weight, 0);
    let anchorCum = 0;
    const anchorCumDist = anchors.map((a) => {
      anchorCum += a.weight / anchorWeightTotal;
      return anchorCum;
    });
    const trajectoryCount = Math.max(5, Math.floor(safeCellTypes * 0.45));
    const trajectories = [];
    for (let t = 0; t < trajectoryCount; t++) {
      const a = anchors[Math.floor(syntheticUnitRandom() * anchors.length)];
      let b = anchors[Math.floor(syntheticUnitRandom() * anchors.length)];
      if (a === b) b = anchors[(anchors.indexOf(a) + 1) % anchors.length];
      const midX = (a.center[0] + b.center[0]) / 2 + (syntheticUnitRandom() - 0.5) * 0.25;
      const midY = (a.center[1] + b.center[1]) / 2 + (syntheticUnitRandom() - 0.5) * 0.25;
      const arch = (syntheticUnitRandom() - 0.5) * 0.25;
      const spread = 0.015 + syntheticUnitRandom() * 0.03;
      const weight = 0.4 + syntheticUnitRandom() * 1.1;
      trajectories.push({
        from: a,
        to: b,
        control: [midX, midY, (a.layerOffset + b.layerOffset) / 2 + arch],
        spread,
        weight
      });
    }
    const trajWeightTotal = trajectories.reduce((s, tr) => s + tr.weight, 0);
    let trajCum = 0;
    const trajCumDist = trajectories.map((tr) => {
      trajCum += tr.weight / trajWeightTotal;
      return trajCum;
    });
    const pickAnchor = () => {
      const r = syntheticUnitRandom();
      let idx = anchorCumDist.findIndex((c) => r <= c);
      if (idx < 0) idx = anchors.length - 1;
      return anchors[idx];
    };
    const pickTrajectory = () => {
      const r = syntheticUnitRandom();
      let idx = trajCumDist.findIndex((c) => r <= c);
      if (idx < 0) idx = trajectories.length - 1;
      return trajectories[idx];
    };
    const anchorPoints = Math.floor(count * anchorFrac);
    const trajectoryPoints = Math.floor(count * trajFrac);
    const rarePoints = count - anchorPoints - trajectoryPoints;
    for (let i = 0; i < anchorPoints; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(syntheticUnitRandom() * batchOffsets.length)];
      const anchor = pickAnchor();
      const dx = this._gaussianRandom() * anchor.spread[0];
      const dy = this._gaussianRandom() * anchor.spread[1];
      positions[idx] = anchor.center[0] + dx * anchor.cos - dy * anchor.sin + batch.offset[0];
      positions[idx + 1] = anchor.center[1] + dx * anchor.sin + dy * anchor.cos + batch.offset[1];
      positions[idx + 2] = anchor.layerOffset + this._gaussianRandom() * 0.03 + batch.offset[2];
      const baseColor = anchor.color;
      const shade = (syntheticUnitRandom() - 0.5) * 0.08 + batch.tint;
      const cidx = i * 4;
      colors[cidx] = Math.round(clamp01(baseColor[0] + shade) * 255);
      colors[cidx + 1] = Math.round(clamp01(baseColor[1] + shade * 0.6) * 255);
      colors[cidx + 2] = Math.round(clamp01(baseColor[2] - shade * 0.6) * 255);
      colors[cidx + 3] = 255;
    }
    for (let i = anchorPoints; i < anchorPoints + trajectoryPoints; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(syntheticUnitRandom() * batchOffsets.length)];
      const traj = pickTrajectory();
      const t = syntheticUnitRandom();
      const eased = t * t * (3 - 2 * t);
      const inv = 1 - eased;
      const px = inv * inv * traj.from.center[0] + 2 * inv * eased * traj.control[0] + eased * eased * traj.to.center[0];
      const py = inv * inv * traj.from.center[1] + 2 * inv * eased * traj.control[1] + eased * eased * traj.to.center[1];
      const pz = inv * inv * traj.from.layerOffset + 2 * inv * eased * traj.control[2] + eased * eased * traj.to.layerOffset;
      positions[idx] = px + this._gaussianRandom() * traj.spread + batch.offset[0] * 0.6;
      positions[idx + 1] = py + this._gaussianRandom() * traj.spread + batch.offset[1] * 0.6;
      positions[idx + 2] = pz + this._gaussianRandom() * traj.spread * 0.6 + batch.offset[2] * 0.8;
      const mixColor = [
        traj.from.color[0] * (1 - eased) + traj.to.color[0] * eased,
        traj.from.color[1] * (1 - eased) + traj.to.color[1] * eased,
        traj.from.color[2] * (1 - eased) + traj.to.color[2] * eased
      ];
      const shade = (syntheticUnitRandom() - 0.5) * 0.06 + batch.tint * 0.6;
      const cidx = i * 4;
      colors[cidx] = Math.round(clamp01(mixColor[0] + shade) * 255);
      colors[cidx + 1] = Math.round(clamp01(mixColor[1] + shade * 0.6) * 255);
      colors[cidx + 2] = Math.round(clamp01(mixColor[2] - shade * 0.4) * 255);
      colors[cidx + 3] = 255;
    }
    for (let i = anchorPoints + trajectoryPoints; i < count; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(syntheticUnitRandom() * batchOffsets.length)];
      if (syntheticUnitRandom() < 0.7) {
        const anchor = pickAnchor();
        const radius = anchor.spread[0] * (0.2 + syntheticUnitRandom() * 0.4);
        const theta = syntheticUnitRandom() * Math.PI * 2;
        positions[idx] = anchor.center[0] + Math.cos(theta) * radius + batch.offset[0] * (strongBatchEffects ? 1 : 0.4);
        positions[idx + 1] = anchor.center[1] + Math.sin(theta) * radius + batch.offset[1] * (strongBatchEffects ? 1 : 0.4);
        positions[idx + 2] = anchor.layerOffset + this._gaussianRandom() * 0.02 + batch.offset[2];
        const cidx = i * 4;
        const shade = 0.1 + (syntheticUnitRandom() - 0.5) * 0.08 + batch.tint;
        colors[cidx] = Math.round(clamp01(anchor.color[0] + shade) * 255);
        colors[cidx + 1] = Math.round(clamp01(anchor.color[1] + shade * 0.5) * 255);
        colors[cidx + 2] = Math.round(clamp01(anchor.color[2] - shade * 0.5) * 255);
        colors[cidx + 3] = 255;
      } else {
        positions[idx] = (syntheticUnitRandom() - 0.5) * 3 + batch.offset[0] * 0.5;
        positions[idx + 1] = (syntheticUnitRandom() - 0.5) * 3 + batch.offset[1] * 0.5;
        positions[idx + 2] = (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 2 : 1) + batch.offset[2] * 0.7;
        const cidx = i * 4;
        const base = this._hslToRgb(syntheticUnitRandom(), 0.2, 0.55);
        colors[cidx] = Math.round(clamp01(base[0]) * 255);
        colors[cidx + 1] = Math.round(clamp01(base[1]) * 255);
        colors[cidx + 2] = Math.round(clamp01(base[2]) * 255);
        colors[cidx + 3] = 200 + Math.floor(syntheticUnitRandom() * 55);
      }
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Variant of atlasLike with intentionally strong batch shifts for stress tests.
   */
  static batchEffects(count, batches = 4) {
    return this.atlasLike(count, {
      batches,
      strongBatchEffects: true,
      trajectoryFraction: 0.18,
      rareFraction: 0.06,
      layerDepth: 0.65,
      label: "Batch effects (misaligned batches)"
    });
  }
  /**
   * Generate Gaussian clusters (100-200 clusters by default)
   */
  static gaussianClusters(count, numClusters = 150, clusterSpread = 0.06) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    const actualClusters = numClusters === 150 ? 100 + Math.floor(syntheticUnitRandom() * 100) : numClusters;
    console.log(`Generating ${formatCountOf(count, "point")} in ${formatCountOf(actualClusters, "cluster")}...`);
    const startTime = performance.now();
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const clusters = [];
    for (let c = 0; c < actualClusters; c++) {
      const center = [
        (syntheticUnitRandom() - 0.5) * 2,
        (syntheticUnitRandom() - 0.5) * 2,
        (syntheticUnitRandom() - 0.5) * 2
      ];
      const size = clusterSpread * (0.5 + syntheticUnitRandom() * 1.5);
      const elongation = [
        0.5 + syntheticUnitRandom() * 1,
        0.5 + syntheticUnitRandom() * 1,
        0.5 + syntheticUnitRandom() * 1
      ];
      const hue = (Math.atan2(center[1], center[0]) / Math.PI + 1) / 2;
      const sat = 0.5 + center[2] * 0.25;
      const color = this._hslToRgb(hue, Math.max(0.4, Math.min(0.9, sat)), 0.5);
      const weight = 0.5 + syntheticUnitRandom() * 1.5;
      clusters.push({ center, size, elongation, color, weight });
    }
    const totalWeight = clusters.reduce((s, c) => s + c.weight, 0);
    clusters.forEach((c) => c.weight /= totalWeight);
    let cumulative = 0;
    const cumDist = clusters.map((c) => {
      cumulative += c.weight;
      return cumulative;
    });
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const r = syntheticUnitRandom();
      let clusterIdx = cumDist.findIndex((c) => r <= c);
      if (clusterIdx < 0) clusterIdx = actualClusters - 1;
      const cluster = clusters[clusterIdx];
      positions[idx] = cluster.center[0] + this._gaussianRandom() * cluster.size * cluster.elongation[0];
      positions[idx + 1] = cluster.center[1] + this._gaussianRandom() * cluster.size * cluster.elongation[1];
      positions[idx + 2] = cluster.center[2] + this._gaussianRandom() * cluster.size * cluster.elongation[2];
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, cluster.color[0] + (syntheticUnitRandom() - 0.5) * 0.1)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, cluster.color[1] + (syntheticUnitRandom() - 0.5) * 0.1)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, cluster.color[2] + (syntheticUnitRandom() - 0.5) * 0.1)) * 255);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate uniform random distribution
   */
  static uniformRandom(count, scale = 2) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    console.log(`Generating ${formatCount(count)} random ${countNoun(count, "point")}...`);
    const startTime = performance.now();
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      positions[idx] = (syntheticUnitRandom() - 0.5) * scale * 2;
      positions[idx + 1] = (syntheticUnitRandom() - 0.5) * scale * 2;
      positions[idx + 2] = (syntheticUnitRandom() - 0.5) * scale * 2;
      const cidx = i * 4;
      colors[cidx] = Math.floor(syntheticUnitRandom() * 256);
      colors[cidx + 1] = Math.floor(syntheticUnitRandom() * 256);
      colors[cidx + 2] = Math.floor(syntheticUnitRandom() * 256);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate points by sampling from a GLB mesh surface
   * @param {number} count - Number of points to generate
   * @param {ArrayBuffer} glbBuffer - The loaded GLB file as ArrayBuffer
   * @returns {Object} - { positions: Float32Array, colors: Uint8Array (RGBA), dimensionLevel: number }
   */
  static fromGLB(count, glbBuffer) {
    requireSyntheticPointCount(count);
    restartSyntheticStream();
    if (!(glbBuffer instanceof ArrayBuffer) || glbBuffer.byteLength === 0) {
      throw new TypeError(
        "GLB benchmark input must be one non-empty ArrayBuffer."
      );
    }
    console.log(`[GLB] Sampling ${formatCountOf(count, "point")} from GLB mesh...`);
    const startTime = performance.now();
    console.log("[GLB] Parsing GLB file...");
    const meshData = GLBParser.parse(glbBuffer);
    console.log(`[GLB] Parsed: ${formatCountOf(meshData.positions.length / 3, "vertex", "vertices")}, ${meshData.indices ? formatCountOf(meshData.indices.length / 3, "triangle") : "no triangles"} (${(performance.now() - startTime).toFixed(0)}ms)`);
    console.log("[GLB] Building surface sampler...");
    const sampler = new MeshSurfaceSampler(meshData.positions, meshData.indices);
    console.log(`[GLB] Sampler ready: ${formatCountOf(sampler.triangleCount, "triangle")}, area=${sampler.totalArea.toFixed(4)} (${(performance.now() - startTime).toFixed(0)}ms)`);
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < meshData.positions.length; i += 3) {
      minX = Math.min(minX, meshData.positions[i]);
      maxX = Math.max(maxX, meshData.positions[i]);
      minY = Math.min(minY, meshData.positions[i + 1]);
      maxY = Math.max(maxY, meshData.positions[i + 1]);
      minZ = Math.min(minZ, meshData.positions[i + 2]);
      maxZ = Math.max(maxZ, meshData.positions[i + 2]);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const scale = 2 / Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    console.log("[GLB] Sampling points...");
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const normal = new Float64Array(3);
    const logInterval = Math.max(1e5, Math.floor(count / 10));
    for (let i = 0; i < count; i++) {
      if (i > 0 && i % logInterval === 0) {
        console.log(`[GLB] Sampled ${(i / 1e3).toFixed(0)}K / ${(count / 1e3).toFixed(0)}K points...`);
      }
      const idx = i * 3;
      sampler._sampleIntoUnchecked(positions, idx, normal, 0);
      positions[idx] = (positions[idx] - centerX) * scale;
      positions[idx + 1] = (positions[idx + 1] - centerY) * scale;
      positions[idx + 2] = (positions[idx + 2] - centerZ) * scale;
      const nx = normal[0];
      const ny = normal[1];
      const nz = normal[2];
      const warmCool = (ny + 1) * 0.5;
      const hue = 0.55 - warmCool * 0.4;
      const sat = 0.6 + Math.abs(nz) * 0.2;
      const light = 0.45 + Math.abs(nx) * 0.15;
      const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
      const p = 2 * light - q;
      const red = hueToRgbChannel(p, q, hue + 1 / 3);
      const green = hueToRgbChannel(p, q, hue);
      const blue = hueToRgbChannel(p, q, hue - 1 / 3);
      const cidx = i * 4;
      colors[cidx] = normalizedByte(
        red + (syntheticUnitRandom() - 0.5) * 0.05
      );
      colors[cidx + 1] = normalizedByte(
        green + (syntheticUnitRandom() - 0.5) * 0.05
      );
      colors[cidx + 2] = normalizedByte(
        blue + (syntheticUnitRandom() - 0.5) * 0.05
      );
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`[GLB] Done! Sampled ${formatCountOf(count, "point")} in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Load GLB file from URL and sample points
   * @param {number} count - Number of points to generate
   * @param {string} url - URL to the GLB file
   * @returns {Promise<Object>} - { positions: Float32Array, colors: Uint8Array (RGBA), dimensionLevel: number }
   */
  static async fromGLBUrl(count, url = "assets/img/kemal-inecik.glb") {
    requireSyntheticPointCount(count);
    if (typeof url !== "string" || url.length === 0 || url !== url.trim()) {
      throw new TypeError(
        "GLB benchmark URL must be one non-empty exact string."
      );
    }
    const resolvedUrl = typeof window !== "undefined" ? new URL(url, window.location.href).toString() : url;
    console.log(`Loading GLB from: ${resolvedUrl}`);
    let bufferPromise = glbBufferPromises.get(resolvedUrl);
    if (bufferPromise === void 0) {
      bufferPromise = (async () => {
        const response = await fetch(resolvedUrl, { cache: "default" });
        if (!response.ok) {
          throw new Error(
            `Failed to load GLB: ${response.status} ${response.statusText}`
          );
        }
        const buffer2 = await response.arrayBuffer();
        if (buffer2.byteLength === 0) {
          throw new Error("Failed to load GLB: response body is empty");
        }
        return buffer2;
      })();
      glbBufferPromises.set(resolvedUrl, bufferPromise);
    }
    let buffer;
    try {
      buffer = await bufferPromise;
    } catch (error) {
      if (glbBufferPromises.get(resolvedUrl) === bufferPromise) {
        glbBufferPromises.delete(resolvedUrl);
      }
      throw error;
    }
    console.log(`GLB loaded: ${(buffer.byteLength / 1024).toFixed(1)} KB`);
    return this.fromGLB(count, buffer);
  }
  static _gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = syntheticUnitRandom();
    while (v === 0) v = syntheticUnitRandom();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  static _hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hueToRgbChannel(p, q, h + 1 / 3);
      g = hueToRgbChannel(p, q, h);
      b = hueToRgbChannel(p, q, h - 1 / 3);
    }
    return [r, g, b];
  }
};

// assets/js/app/ui/modules/benchmark/generation-worker.js
var GENERATORS = Object.freeze({
  atlas: (count) => SyntheticDataGenerator.atlasLike(count),
  batches: (count) => SyntheticDataGenerator.batchEffects(count),
  clusters: (count) => SyntheticDataGenerator.gaussianClusters(count),
  flatumap: (count) => SyntheticDataGenerator.flatUMAP(count),
  glb: (count, sourceUrl) => SyntheticDataGenerator.fromGLBUrl(count, sourceUrl),
  octopus: (count) => SyntheticDataGenerator.octopus(count),
  spirals: (count) => SyntheticDataGenerator.spirals(count),
  uniform: (count) => SyntheticDataGenerator.uniformRandom(count)
});
self.addEventListener("message", async (event) => {
  let request;
  try {
    request = assertGenerationRequest(event.data);
  } catch (error) {
    self.postMessage({
      requestId: Number.isSafeInteger(event.data?.requestId) ? event.data.requestId : -1,
      ok: false,
      name: error.name,
      message: error.message
    });
    return;
  }
  const startedAt = performance.now();
  try {
    const data = await GENERATORS[request.pattern](
      request.count,
      request.sourceUrl
    );
    const elapsedMs = performance.now() - startedAt;
    self.postMessage(
      {
        requestId: request.requestId,
        ok: true,
        positions: data.positions,
        colors: data.colors,
        dimensionLevel: data.dimensionLevel,
        elapsedMs
      },
      [data.positions.buffer, data.colors.buffer]
    );
  } catch (error) {
    self.postMessage({
      requestId: request.requestId,
      ok: false,
      name: error.name,
      message: error.message
    });
  }
});
//# sourceMappingURL=generation-worker.2388d33af93d.js.map
