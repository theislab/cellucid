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

// assets/js/utils/exact-record.js
function setOwnDataProperty(record, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  } else {
    record[key] = value;
  }
  return value;
}
var EMPTY_KEYS = Object.freeze([]);
function typeFailure(message) {
  return new TypeError(message);
}
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function requirePlainRecord(value, label, fail = typeFailure) {
  if (!isPlainRecord(value)) {
    throw fail(`${label} must be a plain object; got ${describeValue(value)}.`, {
      reason: "type",
      missing: [],
      unexpected: []
    });
  }
  return (
    /** @type {T & Record<string, unknown>} */
    value
  );
}
function describeValue(value) {
  if (value === null || value === void 0) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const name = Object.getPrototypeOf(value)?.constructor?.name;
    return name ? `a ${name}` : "an object";
  }
  return `a ${typeof value}`;
}
function includesKey(keys, key) {
  return keys instanceof Set ? keys.has(key) : keys.includes(key);
}
function sortedKeys(keys) {
  return [...keys].sort();
}
function describeAllowedKeys(required, optional) {
  if (optional.length === 0) {
    return required.length === 0 ? "must be empty" : `must contain exactly: ${required.join(", ")}`;
  }
  if (required.length === 0) return `may contain only: ${optional.join(", ")}`;
  return `must contain ${required.join(", ")} and may also contain ${optional.join(", ")}`;
}
function requireKeys(value, required, optional, label, fail = typeFailure) {
  return checkKeys(requirePlainRecord(value, label, fail), required, optional, label, fail);
}
function checkKeys(record, required, optional, label, fail) {
  const requiredKeys = Array.isArray(required) || required instanceof Set ? required : [...required];
  const optionalKeys = Array.isArray(optional) || optional instanceof Set ? optional : [...optional];
  let missing = null;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) (missing ??= []).push(key);
  }
  let unexpected = null;
  for (const key of Object.keys(record)) {
    if (!includesKey(requiredKeys, key) && !includesKey(optionalKeys, key)) {
      (unexpected ??= []).push(key);
    }
  }
  if (missing === null && unexpected === null) return record;
  const missingKeys = missing === null ? [] : missing.sort();
  const unexpectedKeys = unexpected === null ? [] : unexpected.sort();
  const details = [
    ...missingKeys.length > 0 ? [`missing: ${missingKeys.join(", ")}`] : [],
    ...unexpectedKeys.length > 0 ? [`unexpected: ${unexpectedKeys.join(", ")}`] : []
  ];
  throw fail(
    `${label} ${describeAllowedKeys(
      sortedKeys(requiredKeys),
      sortedKeys(optionalKeys).filter((key) => !includesKey(requiredKeys, key))
    )} (${details.join("; ")}).`,
    { reason: "keys", missing: missingKeys, unexpected: unexpectedKeys }
  );
}
function requireExactKeys(value, keys, label, fail = typeFailure) {
  return requireKeys(value, keys, EMPTY_KEYS, label, fail);
}

// assets/js/utils/large-arrays.js
var MEMORY_PAGE_BYTES = 65536;
var MEMORY_MAX_BYTES = 2 ** 32;
var ARRAY_PIECE_BYTES = 2 ** 24 * 3 * 4;
var TYPED_ARRAYS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array
});
var memoryBuffers = /* @__PURE__ */ new WeakSet();
function allocateInMemory(ArrayType, length) {
  const bytes = length * ArrayType.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`A typed array holds a non-negative whole number of elements, not ${length}.`);
  }
  if (bytes > MEMORY_MAX_BYTES) {
    throw new RangeError(
      `${formatCountOf(bytes, "byte")} is more than one WebAssembly memory holds (${formatCountOf(MEMORY_MAX_BYTES, "byte")}), the largest array a browser page can allocate.`
    );
  }
  const pages = Math.ceil(bytes / MEMORY_PAGE_BYTES);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  memoryBuffers.add(memory.buffer);
  return new ArrayType(memory.buffer, 0, length);
}
function allocateLargeArray(ArrayType, length) {
  try {
    return new ArrayType(length);
  } catch (refused) {
    if (!(refused instanceof RangeError) || typeof WebAssembly?.Memory !== "function" || !(length * ArrayType.BYTES_PER_ELEMENT <= MEMORY_MAX_BYTES)) throw refused;
    try {
      return allocateInMemory(ArrayType, length);
    } catch {
      throw refused;
    }
  }
}
function typedArrayOf(name) {
  const ArrayType = Object.hasOwn(TYPED_ARRAYS, name) ? TYPED_ARRAYS[name] : void 0;
  if (ArrayType === void 0) throw new TypeError(`'${String(name)}' is not a typed array a piece can hold.`);
  return ArrayType;
}
var ArrayAssembly = class {
  /**
   * @param {new (length: number) => ArrayBufferView} ArrayType
   * @param {number} length
   */
  constructor(ArrayType, length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`An assembled array holds a non-negative whole number of elements, not ${length}.`);
    }
    this.ArrayType = ArrayType;
    this.length = length;
    this.array = null;
    this.filled = 0;
  }
  /**
   * Copy one piece in.
   *
   * @param {number} offset - Its first element in the whole array
   * @param {ArrayBufferView} values
   */
  put(offset, values) {
    if (!(values instanceof this.ArrayType)) {
      throw new TypeError(`A piece of a ${this.ArrayType.name} is one too, not ${values?.constructor?.name}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + values.length > this.length) {
      throw new RangeError(`A piece at ${offset} of ${formatCountOf(values.length, "element")} lies outside an array of ${formatCountOf(this.length, "element")}.`);
    }
    if (this.array === null && offset === 0 && values.length === this.length) {
      this.array = values;
    } else {
      this.array ??= allocateLargeArray(this.ArrayType, this.length);
      this.array.set(values, offset);
    }
    this.filled += values.length;
  }
  /** The whole array, once every element arrived. */
  get result() {
    if (this.filled !== this.length) {
      throw new RangeError(`An array of ${formatCountOf(this.length, "element")} was assembled from ${formatCountOf(this.filled, "element")}.`);
    }
    return this.array ?? new this.ArrayType(0);
  }
};
function mapChanged(items, map) {
  let out = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null || typeof item !== "object") continue;
    const mapped = map(item);
    if (mapped !== item) {
      out ??= items.slice();
      out[i] = mapped;
    }
  }
  return out ?? items;
}
function isPlaceholder(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 1 && Number.isSafeInteger(value.arrayPieces);
}
function assembledArrays(value, assemblies, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4 || ArrayBuffer.isView(value)) return value;
  if (isPlaceholder(value)) {
    const assembly = assemblies.get(value.arrayPieces);
    if (assembly === void 0) throw new RangeError(`The pieces of array ${value.arrayPieces} never arrived.`);
    assemblies.delete(value.arrayPieces);
    return assembly.result;
  }
  if (Array.isArray(value)) return mapChanged(value, (item) => assembledArrays(item, assemblies, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let copy = null;
  for (const key of Object.keys(value)) {
    const resolved = assembledArrays(value[key], assemblies, depth + 1);
    if (resolved !== value[key]) {
      copy ??= { ...value };
      setOwnDataProperty(copy, key, resolved);
    }
  }
  return copy ?? value;
}
var PieceReceiver = class {
  constructor() {
    this.assemblies = /* @__PURE__ */ new Map();
  }
  /** Take one piece message (`{array, type, length, offset, values}`). */
  receive({ array, type, length, offset, values }) {
    let assembly = this.assemblies.get(array);
    if (assembly === void 0) {
      assembly = new ArrayAssembly(typedArrayOf(type), length);
      this.assemblies.set(array, assembly);
    }
    assembly.put(offset, values);
  }
  /** `value` with its placeholders replaced by the assembled arrays, which the receiver then lets go of. */
  resolve(value) {
    return assembledArrays(value, this.assemblies);
  }
};

// assets/js/rendering/unplaced-positions.js
var UNPLACED_GPU_POSITION = 3e38;
var UNPLACED_GLSL = `
// A cell its embedding does not place (rendering/unplaced-positions.js):
// rejected before rasterization.
bool isUnplacedPosition(vec3 position) { return abs(position.x) > 1.0e38; }
`;
function isUnplacedCell(positions, dimension, cell) {
  const x = positions[cell * dimension];
  return x !== x;
}
var UNPLACED_COUNTS = /* @__PURE__ */ new WeakMap();
function unplacedCountOf(positions, dimension) {
  let count = UNPLACED_COUNTS.get(positions);
  if (count === void 0) {
    count = 0;
    for (let at = 0; at < positions.length; at += dimension) {
      const x = positions[at];
      if (x !== x) count++;
    }
    UNPLACED_COUNTS.set(positions, count);
  }
  return count;
}
function positionsForGpu(positions, dimension) {
  return rowsForGpu(positions, dimension, UNPLACED_GPU_POSITION);
}
function rowsForGpu(rows, width, standIn) {
  if (unplacedCountOf(rows, width) === 0) return rows;
  const out = allocateLargeArray(Float32Array, rows.length);
  out.set(rows);
  for (let at = 0; at < out.length; at += width) {
    const x = out[at];
    if (x !== x) out.fill(standIn, at, at + width);
  }
  return out;
}

// assets/js/rendering/position-layout.js
var POSITION_BYTES_PER_COMPONENT = Float32Array.BYTES_PER_ELEMENT;
function requirePositionDimension(dimension, label = "Position dimension") {
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError(`${label} must be exactly 1, 2, or 3.`);
  }
  return dimension;
}
function requirePositionArray(positions, dimension, label = "Positions", { allowEmpty = false, pointCount = null } = {}) {
  const exactDimension = requirePositionDimension(dimension, `${label} dimension`);
  if (!(positions instanceof Float32Array) || positions.length % exactDimension !== 0 || !allowEmpty && positions.length === 0) {
    throw new TypeError(
      `${label} must be a ${allowEmpty ? "" : "non-empty "}Float32Array with exactly ${formatCountOf(exactDimension, "value")} per point.`
    );
  }
  const count = positions.length / exactDimension;
  if (pointCount !== null && count !== pointCount) {
    throw new RangeError(
      `${label} must contain exactly ${formatCountOf(pointCount * exactDimension, "value")} (${formatCountOf(pointCount, "point")} of ${exactDimension}); received ${positions.length}.`
    );
  }
  return count;
}

// assets/js/app/ui/modules/figure-export/utils/crop.js
var MIN_NORM_SIZE = 0.02;
var CROP_INPUT_KEYS = Object.freeze([
  "enabled",
  "height",
  "width",
  "x",
  "y"
]);
var CROP_RECT_KEYS = Object.freeze(["height", "width", "x", "y"]);
function assertRectNumbers(rect, context) {
  for (const key of CROP_RECT_KEYS) {
    if (typeof rect[key] !== "number" || !Number.isFinite(rect[key])) {
      throw new TypeError(`${context}.${key} must be a finite number.`);
    }
  }
  if (rect.x < 0 || rect.y < 0) {
    throw new RangeError(`${context} origin must be within the viewport.`);
  }
  if (rect.width < MIN_NORM_SIZE || rect.height < MIN_NORM_SIZE) {
    throw new RangeError(
      `${context} width and height must each be at least ${MIN_NORM_SIZE}.`
    );
  }
  if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    throw new RangeError(`${context} must be fully contained in the viewport.`);
  }
}
function assertCropRect01(crop) {
  if (crop === null) return null;
  requireExactKeys(crop, CROP_INPUT_KEYS, "Figure export crop");
  if (crop.enabled !== true) {
    throw new TypeError(
      "Figure export crop.enabled must be true; use null when cropping is disabled."
    );
  }
  assertRectNumbers(crop, "Figure export crop");
  return {
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height
  };
}
function assertNormalizedRect01(rect, context) {
  requireExactKeys(rect, CROP_RECT_KEYS, context);
  assertRectNumbers(rect, context);
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
function cropRect01ToPx(crop01, viewportWidth, viewportHeight) {
  if (crop01 === null) return null;
  assertNormalizedRect01(crop01, "Normalized figure export crop");
  if (typeof viewportWidth !== "number" || !Number.isFinite(viewportWidth) || viewportWidth <= 0 || typeof viewportHeight !== "number" || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new TypeError(
      "Figure export crop viewport dimensions must be finite positive numbers."
    );
  }
  return {
    x: crop01.x * viewportWidth,
    y: crop01.y * viewportHeight,
    width: crop01.width * viewportWidth,
    height: crop01.height * viewportHeight
  };
}

// assets/js/app/ui/modules/figure-export/utils/plot-fit.js
var ASPECT_TOLERANCE = 1e-6;
function requirePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite positive number.`);
  }
  return value;
}
function figureSourceRect({ renderState, crop = null }) {
  const viewportWidth = requirePositive(renderState?.viewportWidth, "Figure source viewport width");
  const viewportHeight = requirePositive(renderState?.viewportHeight, "Figure source viewport height");
  const cropPx = cropRect01ToPx(assertCropRect01(crop), viewportWidth, viewportHeight);
  return Object.freeze({
    viewportWidth,
    viewportHeight,
    x: cropPx === null ? 0 : cropPx.x,
    y: cropPx === null ? 0 : cropPx.y,
    width: cropPx === null ? viewportWidth : cropPx.width,
    height: cropPx === null ? viewportHeight : cropPx.height
  });
}
function createPlotPlacement({ renderState, plotRect, crop = null }) {
  const source = figureSourceRect({ renderState, crop });
  const scaleX = requirePositive(plotRect?.width, "Figure plot width") / source.width;
  const scaleY = requirePositive(plotRect?.height, "Figure plot height") / source.height;
  if (Math.abs(scaleX / scaleY - 1) > ASPECT_TOLERANCE) {
    throw new RangeError(
      "Figure plot rectangle must have its view's aspect (fitPlotSize); a figure is never letterboxed."
    );
  }
  const originX = plotRect.x - source.x * scaleX;
  const originY = plotRect.y - source.y * scaleY;
  return {
    source,
    scale: scaleX,
    viewportToPlot: (vx, vy) => ({ x: originX + vx * scaleX, y: originY + vy * scaleY })
  };
}
function projectIntoSource(mvp, source, x, y, z, out) {
  const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (!(clipW > 0) || clipW === Infinity) return false;
  const ndcX = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / clipW;
  const ndcY = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / clipW;
  const ndcZ = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / clipW;
  if (!(ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && ndcZ >= -1 && ndcZ <= 1)) {
    return false;
  }
  const localX = (ndcX * 0.5 + 0.5) * source.viewportWidth - source.x;
  const localY = (0.5 - ndcY * 0.5) * source.viewportHeight - source.y;
  if (!(localX >= 0 && localX <= source.width && localY >= 0 && localY <= source.height)) {
    return false;
  }
  out[0] = localX;
  out[1] = localY;
  out[2] = ndcZ;
  return true;
}

// assets/js/rendering/shader-quality.js
var SHADER_QUALITIES = Object.freeze([
  "full",
  "sculpted",
  "light",
  "ultralight"
]);
var SHADER_QUALITY_TRAITS = Object.freeze({
  full: Object.freeze({ fog: true, fogAlpha: true, sphere: true }),
  sculpted: Object.freeze({ fog: true, fogAlpha: false, sphere: true }),
  light: Object.freeze({ fog: false, fogAlpha: false, sphere: false }),
  ultralight: Object.freeze({ fog: false, fogAlpha: false, sphere: false })
});
var DESCRIBED_QUALITIES = `${SHADER_QUALITIES.slice(0, -1).map((quality) => `"${quality}"`).join(", ")}, or "${SHADER_QUALITIES.at(-1)}"`;
function describeShaderQualities() {
  return DESCRIBED_QUALITIES;
}

// assets/js/rendering/high-perf/renderer-contracts.js
var SUPPORTED_DIMENSION_LEVELS = /* @__PURE__ */ new Set([1, 2, 3]);
var SUPPORTED_SHADER_QUALITIES = new Set(SHADER_QUALITIES);
var REQUIRED_RENDER_SCALAR_KEYS = Object.freeze([
  "pointSize",
  "sizeAttenuation",
  "viewportHeight",
  "viewportWidth",
  "fov",
  "lightingStrength",
  "fogDensity",
  "cameraDistance",
  // The sprite cap every pass draws with (rendering/point-sprite.js).
  "pointSizeMax"
]);
var REQUIRED_RENDER_VECTOR_CONTRACTS = Object.freeze([
  Object.freeze(["mvpMatrix", 16]),
  Object.freeze(["viewMatrix", 16]),
  Object.freeze(["modelMatrix", 16]),
  Object.freeze(["projectionMatrix", 16]),
  Object.freeze(["fogColor", 3]),
  Object.freeze(["lightDir", 3]),
  Object.freeze(["cameraPosition", 3])
]);
var LOD_FULL_DETAIL_ADMISSION_LEVEL = 255;
function cellsOf(value) {
  return Number.isFinite(value) ? formatCountOf(value, "cell") : `${String(value)} (not a count of cells)`;
}
function requireLodMembership(membership, { pointCount, dimensionLevel = null, requireIndices = false, owner }) {
  if (membership === null) return null;
  if (membership === void 0 || typeof membership !== "object" || Array.isArray(membership) || !Object.isFrozen(membership)) {
    throw new TypeError(`${owner} must be null or one frozen level-of-detail membership.`);
  }
  const { admissionLevels, count, generationToken, indices, lodLevel } = membership;
  if (!Number.isSafeInteger(membership.pointCount) || membership.pointCount !== pointCount || !SUPPORTED_DIMENSION_LEVELS.has(membership.dimensionLevel) || dimensionLevel !== null && membership.dimensionLevel !== dimensionLevel) {
    throw new RangeError(
      `${owner} describes ${cellsOf(membership.pointCount)} in ${String(membership.dimensionLevel)}D, not the view's ${cellsOf(pointCount)}${dimensionLevel === null ? "" : ` in ${dimensionLevel}D`}.`
    );
  }
  if (!Number.isInteger(lodLevel) || lodLevel < 0 || lodLevel >= LOD_FULL_DETAIL_ADMISSION_LEVEL || !Number.isSafeInteger(count) || count < 0 || count > pointCount) {
    throw new RangeError(
      `${owner} must name a reduced level below ${LOD_FULL_DETAIL_ADMISSION_LEVEL} drawing at most ${cellsOf(pointCount)}.`
    );
  }
  if (generationToken === null || typeof generationToken !== "object" || !Object.isFrozen(generationToken)) {
    throw new TypeError(`${owner} generationToken must be one frozen object.`);
  }
  if (admissionLevels !== null && (!(admissionLevels instanceof Uint8Array) || admissionLevels.length !== pointCount)) {
    throw new TypeError(`${owner} admissionLevels must be null or one byte a cell.`);
  }
  if (indices !== null && (!(indices instanceof Uint32Array) || indices.length !== count) || requireIndices && indices === null) {
    throw new TypeError(
      `${owner} indices must be ${requireIndices ? "" : "null or "}the level's ${cellsOf(count)} as a Uint32Array.`
    );
  }
  return membership;
}
function lodMembershipAdmits(membership, cell) {
  if (membership === null) return true;
  const admissionLevels = membership.admissionLevels;
  return admissionLevels === null ? cell < membership.count : admissionLevels[cell] <= membership.lodLevel;
}

// assets/js/rendering/alpha-visibility.js
var MIN_VISIBLE_ALPHA_BYTE = 3;
var BENEATH_ALPHA_BYTE = 254;
var UNREAD_ALPHA_BYTE = 253;
function requireColorAlphaMeaning(meaning, label) {
  if (meaning !== "layer" && meaning !== "opacity") {
    throw new TypeError(`${label} must say what its colors' alpha byte is: 'layer' or 'opacity', not ${String(meaning)}.`);
  }
  return meaning;
}
var LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
var SINGLE_LAYER = Object.freeze({ layered: false, unread: 0 });
function colorLayersOf(colors) {
  let layered = false;
  let unread = 0;
  if (colors.byteOffset % 4 === 0) {
    const words = new Uint32Array(colors.buffer, colors.byteOffset, colors.length >>> 2);
    const shift = LITTLE_ENDIAN ? 24 : 0;
    for (let i = 0; i < words.length; i++) {
      const alpha = words[i] >>> shift & 255;
      if (alpha !== 255) {
        layered = true;
        if (alpha === UNREAD_ALPHA_BYTE) unread++;
      }
    }
  } else {
    for (let i = 3; i < colors.length; i += 4) {
      if (colors[i] !== 255) {
        layered = true;
        if (colors[i] === UNREAD_ALPHA_BYTE) unread++;
      }
    }
  }
  return layered ? Object.freeze({ layered, unread }) : SINGLE_LAYER;
}
var POINT_VISIBILITY_THRESHOLD = Math.fround(
  (MIN_VISIBLE_ALPHA_BYTE - 0.5) / 255
);

// assets/js/app/state/core/constants.js
var NEUTRAL_GRAY_UINT8 = 211;

// assets/js/rendering/point-sprite.js
var POINT_SPRITE_MIN_PX = 0.5;
var POINT_SPRITE_MAX_PX = 160;
function pointScaleFor(viewportHeight, fov) {
  return viewportHeight / Math.max(2 * Math.tan(fov * 0.5), 1e-6) * 0.01;
}
function gpuPointSizeMax(gl) {
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const max = Array.isArray(range) || ArrayBuffer.isView(range) ? Number(range[1]) : Number.NaN;
  return Number.isFinite(max) && max > 0 ? max : null;
}
function pointSpriteSize(eyeDepth, { pointSize, pointScale, sizeAttenuation, pointSizeMax }) {
  const perspective = pointSize * pointScale / Math.max(eyeDepth, 1e-3);
  const mixed = pointSize * (1 - sizeAttenuation) + perspective * sizeAttenuation;
  return Math.min(Math.max(mixed, POINT_SPRITE_MIN_PX), pointSizeMax);
}
var POINT_SPRITE_GLSL = `
// Point sprite sizing, shared by every point shader (rendering/point-sprite.js).
uniform float u_pointSize;
// The largest sprite this pass draws, in the pixels it draws into: the
// viewer's cap (rendering/point-sprite.js, bounded by the GPU), times a
// figure export's raster scale.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth:
// viewportHeight / (2 tan(fov / 2)) * 0.01.
uniform float u_pointScale;

float pointSpriteSize(float eyeDepth) {
  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  return clamp(mix(u_pointSize, perspectiveSize, u_sizeAttenuation), ${POINT_SPRITE_MIN_PX.toFixed(1)}, u_pointSizeMax);
}
`;

// assets/js/rendering/read-cell-layer.js
var ZERO_LIGHTNESS_CONTRAST = 100 - lightnessOf([NEUTRAL_GRAY_UINT8 / 255, NEUTRAL_GRAY_UINT8 / 255, NEUTRAL_GRAY_UINT8 / 255]);
var READ_CELLS_COVERED_FRACTION = 0.4;
var READ_CELLS_COVERAGE = 4 / Math.PI * Math.log(1 / (1 - READ_CELLS_COVERED_FRACTION));
function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
function lightnessOf(rgb) {
  const y = 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : 24389 / 27 * y;
}
var scratch = { x: new Float32Array(0), y: new Float32Array(0), grid: new Uint8Array(0) };

// assets/js/app/ui/modules/figure-export/utils/lod-membership.js
function assertLodMembership(membership, {
  pointCount = null,
  dimensionLevel = null,
  label = "Figure-export LOD membership"
} = {}) {
  return requireLodMembership(membership, {
    pointCount: pointCount ?? membership?.pointCount,
    dimensionLevel,
    requireIndices: true,
    owner: label
  });
}
function assertDrawOrder(drawOrder, { pointCount, label = "Figure export draw order" }) {
  if (drawOrder === null) return null;
  if (!(drawOrder instanceof Uint32Array) || drawOrder.length !== pointCount) {
    throw new TypeError(`${label} must be null or a Uint32Array of ${pointCount} source indices.`);
  }
  return drawOrder;
}
function drawnSequence(lodMembership, drawOrder, colors = null, readEveryLevel = false) {
  const sequence = lodMembership?.indices ?? drawOrder ?? null;
  if (colors === null) return sequence;
  const layers = colorLayersOf(colors);
  if (!layers.layered) return sequence;
  const readSequence = layers.unread > 0 && readEveryLevel && lodMembership !== null ? drawOrder : sequence;
  const count = sequence === null ? colors.length >>> 2 : sequence.length;
  const readSequenceCount = readSequence === null ? colors.length >>> 2 : readSequence.length;
  let unread = 0;
  for (let k = 0; k < count; k++) {
    if (colors[(sequence === null ? k : sequence[k]) * 4 + 3] === UNREAD_ALPHA_BYTE) unread++;
  }
  let read = readSequenceCount;
  if (readSequence !== sequence || layers.unread > 0) {
    read = 0;
    for (let k = 0; k < readSequenceCount; k++) {
      if (colors[(readSequence === null ? k : readSequence[k]) * 4 + 3] !== UNREAD_ALPHA_BYTE) read++;
    }
  }
  const layered = allocateLargeArray(Uint32Array, unread + read);
  let at = 0;
  const take = (from, fromCount, byte) => {
    for (let k = 0; k < fromCount; k++) {
      const cell = from === null ? k : from[k];
      if (colors[cell * 4 + 3] === byte) layered[at++] = cell;
    }
  };
  take(sequence, count, UNREAD_ALPHA_BYTE);
  take(readSequence, readSequenceCount, BENEATH_ALPHA_BYTE);
  for (let k = 0; k < readSequenceCount; k++) {
    const cell = readSequence === null ? k : readSequence[k];
    const byte = colors[cell * 4 + 3];
    if (byte !== UNREAD_ALPHA_BYTE && byte !== BENEATH_ALPHA_BYTE) layered[at++] = cell;
  }
  return layered;
}
function requireFigurePointLayers(layers, label) {
  if (layers === null) return null;
  if (typeof layers !== "object" || !(Number.isFinite(layers.readScale) && layers.readScale >= 1) || typeof layers.readEveryLevel !== "boolean" || !Array.isArray(layers.unreadColor) || layers.unreadColor.length !== 3 || !layers.unreadColor.every((channel) => channel >= 0 && channel <= 1) || !Array.isArray(layers.zeroColor) || layers.zeroColor.length !== 3 || !layers.zeroColor.every((channel) => channel >= 0 && channel <= 1)) {
    throw new TypeError(`${label} must be null or {readScale >= 1, readEveryLevel, unreadColor, zeroColor: three channels 0..1 each}.`);
  }
  return layers;
}

// assets/js/app/ui/modules/figure-export/utils/coordinate-mapper.js
function sourceHasDrawnCells({
  positions,
  dimension,
  transparency = null,
  lodMembership = null,
  mvpMatrix,
  viewportWidth,
  viewportHeight,
  crop = null
}) {
  if (!positions || !mvpMatrix) return false;
  const source = figureSourceRect({ renderState: { viewportWidth, viewportHeight }, crop });
  const n = requirePositionArray(
    positions,
    dimension,
    "Figure-export positions",
    { allowEmpty: true }
  );
  assertLodMembership(lodMembership, { pointCount: n });
  const admittedIndices = lodMembership?.indices ?? null;
  const candidateCount = admittedIndices?.length ?? n;
  const local = new Float64Array(3);
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
    const rawAlpha = transparency ? transparency[i] ?? 1 : 1;
    const alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1;
    if (alpha < POINT_VISIBILITY_THRESHOLD) continue;
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (projectIntoSource(mvpMatrix, source, x, y, z, local)) return true;
  }
  return false;
}

// assets/js/rendering/gl-utils.js
function asError(value, defaultMessage) {
  return value instanceof Error ? value : new Error(defaultMessage);
}
function attemptCleanup(failures, cleanup, defaultMessage) {
  try {
    cleanup();
  } catch (error) {
    failures.push(asError(error, defaultMessage));
  }
}
function throwTransactionFailure(failures, message) {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}
function createShader(gl, type, source) {
  let shader = null;
  try {
    shader = gl.createShader(type);
    if (!shader) {
      throw new Error("Required WebGL shader allocation failed.");
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      throw new Error("Could not compile shader:\n" + info);
    }
    return shader;
  } catch (error) {
    const failures = [
      asError(error, "WebGL shader creation failed with a non-Error value.")
    ];
    if (shader) {
      attemptCleanup(
        failures,
        () => gl.deleteShader(shader),
        "WebGL shader rollback failed with a non-Error value."
      );
    }
    throwTransactionFailure(
      failures,
      "WebGL shader creation and rollback failed."
    );
  }
}
function createLinkedProgram(gl, vsSource, fsSource, configureProgram, linkFailurePrefix) {
  let vs = null;
  let fs = null;
  let program = null;
  try {
    vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    program = gl.createProgram();
    if (!program) {
      throw new Error("Could not allocate the required WebGL program.");
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    configureProgram(program);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      throw new Error(`${linkFailurePrefix}:
${info}`);
    }
    const cleanupFailures = [];
    const ownedVs = vs;
    vs = null;
    attemptCleanup(
      cleanupFailures,
      () => gl.deleteShader(ownedVs),
      "WebGL vertex-shader cleanup failed with a non-Error value."
    );
    const ownedFs = fs;
    fs = null;
    attemptCleanup(
      cleanupFailures,
      () => gl.deleteShader(ownedFs),
      "WebGL fragment-shader cleanup failed with a non-Error value."
    );
    if (cleanupFailures.length > 0) {
      const ownedProgram = program;
      program = null;
      attemptCleanup(
        cleanupFailures,
        () => gl.deleteProgram(ownedProgram),
        "WebGL program rollback failed with a non-Error value."
      );
      throwTransactionFailure(
        cleanupFailures,
        "WebGL program linked but shader cleanup failed."
      );
    }
    const result = program;
    program = null;
    return result;
  } catch (error) {
    const failures = [
      asError(error, "WebGL program creation failed with a non-Error value.")
    ];
    if (program) {
      attemptCleanup(
        failures,
        () => gl.deleteProgram(program),
        "WebGL program rollback failed with a non-Error value."
      );
    }
    if (fs) {
      attemptCleanup(
        failures,
        () => gl.deleteShader(fs),
        "WebGL fragment-shader rollback failed with a non-Error value."
      );
    }
    if (vs) {
      attemptCleanup(
        failures,
        () => gl.deleteShader(vs),
        "WebGL vertex-shader rollback failed with a non-Error value."
      );
    }
    throwTransactionFailure(
      failures,
      "WebGL program creation and rollback failed."
    );
  }
}
function deleteProgramReleasingUse(gl, program) {
  if (program === null) return;
  if (gl.getParameter(gl.CURRENT_PROGRAM) === program) gl.useProgram(null);
  gl.deleteProgram(program);
}
var DELETED_TEXTURES = /* @__PURE__ */ new WeakSet();
function deleteTextureTracked(gl, texture) {
  if (texture === null || texture === void 0) return;
  gl.deleteTexture(texture);
  DELETED_TEXTURES.add(texture);
}
function createProgram(gl, vsSource, fsSource) {
  return createLinkedProgram(
    gl,
    vsSource,
    fsSource,
    () => {
    },
    "Could not link program"
  );
}
function configureStraightAlphaBlending(gl) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA
  );
}
var MAX_VERTICES_PER_DRAW = 16777216;
function drawPointsInSegments(gl, first, count) {
  let calls = 0;
  for (let offset = 0; offset < count; offset += MAX_VERTICES_PER_DRAW) {
    gl.drawArrays(gl.POINTS, first + offset, Math.min(MAX_VERTICES_PER_DRAW, count - offset));
    calls++;
  }
  return calls;
}
function releaseVertexAttribute(gl, location, holder) {
  if (!holder) {
    throw new TypeError("A vertex attribute is released onto a buffer the vertex array may keep, never onto none.");
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, holder);
  gl.vertexAttribPointer(location, 1, gl.UNSIGNED_BYTE, false, 0, 0);
  gl.disableVertexAttribArray(location);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}
var REPORTS_DEVICE_PIXEL_BOX = typeof ResizeObserverEntry === "function" && "devicePixelContentBoxSize" in ResizeObserverEntry.prototype;

// assets/js/rendering/shaders/fog-shaders.js
var FOG_EXTINCTION_SCALE = 0.6;
var MIN_FOG_SPAN = 1e-4;
var FOG_GLSL = `
// Atmospheric fog (Beer-Lambert), shared by every fogged layer (fog-shaders.js).
// u_fogScale = log2(e) * extinction / span, zero when fog is off.
uniform float u_fogNear;
uniform float u_fogScale;

float fogTransmittance(float viewDistance) {
  return exp2(-u_fogScale * max(viewDistance - u_fogNear, 0.0));
}

// The opacity fog leaves a translucent layer: it fades toward what is behind.
float fogOpacity(float transmittance) {
  return transmittance * (0.1 + 0.9 * transmittance);
}
`;
function fogScale(fogDensity, fogNear, fogFar) {
  const span = Math.max(fogFar - fogNear, MIN_FOG_SPAN);
  return fogDensity * fogDensity * FOG_EXTINCTION_SCALE * Math.LOG2E / span;
}
function writeFogUniforms(gl, nearLocation, scaleLocation, fogDensity, fogNear, fogFar) {
  if (nearLocation !== null) gl.uniform1f(nearLocation, fogNear);
  if (scaleLocation !== null) {
    gl.uniform1f(scaleLocation, fogScale(fogDensity, fogNear, fogFar));
  }
}
function fogOpacityAt(transmittance) {
  return transmittance * (0.1 + 0.9 * transmittance);
}

// assets/js/rendering/linear-texture.js
var LINEAR_TEXEL_GLSL = `
// The texel of item \`index\` in a linear texture (rendering/linear-texture.js):
// shape.x = log2(width), shape.y = rows per layer. (\`layout\` is a GLSL
// keyword, which Firefox's compiler rejects as a name.)
ivec3 linearTexel(int index, ivec2 shape) {
  int row = index >> shape.x;
  int layer = row / shape.y;
  return ivec3(index & ((1 << shape.x) - 1), row - layer * shape.y, layer);
}
`;

// assets/js/rendering/shaders/high-perf-shaders.js
var NO_DEPTH_MAX_DIMENSION = 2;
var FULL_LIGHTING = Object.freeze({ ambient: 0.5, diffuse: 0.5 });
var FULL_AMBIENT_GLSL = FULL_LIGHTING.ambient.toFixed(2);
var FULL_DIFFUSE_GLSL = FULL_LIGHTING.diffuse.toFixed(2);
var HP_VS_FULL = `#version 300 es
precision highp float;

// Two vertex streams: position (float32, 1-3 components; missing axes read as 0)
// and color.rgba (uint8 normalized)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
${POINT_SPRITE_GLSL}
${FOG_GLSL}
// Alpha in source order, one R8 texel a point, as a linear texture
// (rendering/linear-texture.js), for alpha-only updates.
uniform lowp sampler2DArray u_alphaTex;
uniform ivec2 u_alphaLayout;
uniform bool u_useAlphaTex;
// The store order's slot map (slot -> source point), R32UI, so the alpha of
// a point drawn from a reordered store is found exactly at any index. Slots
// from u_orderedSlots on hold their own point (rendering/high-perf/
// store-order.js); 0 for a store in source order.
uniform highp usampler2DArray u_lodIndexTex;
uniform ivec2 u_lodIndexLayout;
uniform int u_orderedSlots;
// The first slot of the store segment drawn: gl_VertexID counts from it
// (rendering/high-perf/point-store-segments.js).
uniform int u_slotBase;
// Which cells this pass draws, by the layer their color's alpha byte names
// (alpha-visibility.js): 0 every one; 1 the grey beneath the colored cells
// (BENEATH_ALPHA_BYTE, 254); 2 the colored cells (255); 3 the cells not read
// (UNREAD_ALPHA_BYTE, 253). A field with lower layers is drawn a layer a
// pass, bottom first (3, 1, 2), so each lies over the one before in 2-D
// blending and wins depth ties in 3-D, at every level of detail and culled
// range.
uniform int u_drawPass;
// The color of a cell not read: the background's, faded toward the grey
// for 0 (rendering/read-cell-layer.js, unreadCellColor). Its own RGB bytes
// are not drawn.
uniform vec3 u_unreadColor;
// The grey of the cells beneath (no value: a gene's 0, a missing value), made
// from the background (rendering/read-cell-layer.js, zeroCellColor). Their
// own RGB bytes are not drawn.
uniform vec3 u_zeroColor;
// The cells of this draw lie beneath the others (pass 1, or a figure's first
// range): with depth tested, each yields to any cell up to one drawn point
// diameter behind it, so an expressing cell on the same surface as the grey
// around it shows in 3-D too, while a cell well in front still occludes.
uniform bool u_yieldDepth;
${LINEAR_TEXEL_GLSL}
${UNPLACED_GLSL}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;
// Fog transmittance (1 is unfogged), and the opacity it leaves a translucent
// point (fog-shaders.js). Full thins the point by the opacity; Sculpted is
// opaque and mixes its color by the transmittance.
flat out float v_fogT;
flat out float v_fogOpacity;

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled, otherwise use vertex attribute
  float alpha;
  if (u_useAlphaTex) {
    // Integer addressing throughout: a float index loses exactness at 2^24.
    int slot = u_slotBase + gl_VertexID;
    int origIdx = slot < u_orderedSlots
      ? int(texelFetch(u_lodIndexTex, linearTexel(slot, u_lodIndexLayout), 0).r)
      : slot;
    alpha = texelFetch(u_alphaTex, linearTexel(origIdx, u_alphaLayout), 0).r;
  } else {
    alpha = a_color.a;
  }

  // The sprite: perspective size and the cap (rendering/point-sprite.js).
  gl_PointSize = pointSpriteSize(eyeDepth);

  // Reject invisible points before rasterisation.
  //
  // Shrinking the point is not enough: ALIASED_POINT_SIZE_RANGE starts at 1.0
  // on this driver, so gl_PointSize = 0.0 is clamped back to one pixel and the
  // point is assembled, rasterised, and shaded before the fragment discard
  // throws it away. Moving the vertex outside the clip volume rejects it up
  // front, which is what makes hiding cells cheaper than showing them instead
  // of more expensive. The size is still zeroed as a second line of defence.
  if (u_yieldDepth) {
    // One drawn diameter in eye units at this depth (u_pointScale: pixels
    // per world unit at unit depth, over 100), the depth moved back by it.
    float diameter = gl_PointSize * eyeDepth / max(100.0 * u_pointScale, 1e-6);
    vec4 yielded = u_projectionMatrix * vec4(eyePos.xy, eyePos.z - diameter, 1.0);
    gl_Position.z = clamp(yielded.z / yielded.w, -1.0, 1.0) * gl_Position.w;
  }
  // The layer byte, exact: a normalized byte is k / 255.
  int layer = int(a_color.a * 255.0 + 0.5);
  if (alpha < 0.01 || isUnplacedPosition(a_position)
    || (u_drawPass == 1 && layer != 254) || (u_drawPass == 2 && layer != 255) || (u_drawPass == 3 && layer != 253)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_fogT = fogTransmittance(length(eyePos.xyz));
  v_fogOpacity = fogOpacity(v_fogT);

  // The passes of the lower layers draw them in their own colors (a
  // figure's raster bakes those into the colors and draws in pass 0).
  v_color = u_drawPass == 3 ? u_unreadColor : (u_drawPass == 1 ? u_zeroColor : a_color.rgb);
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`;
var HP_FS_FULL = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  // One discard for both cases: a hidden point (second line of defence
  // behind HP_VS_FULL's clip-volume rejection) and a sprite corner outside the
  // disc. Two separate discards, the first ahead of everything else, cost more
  // on a dense antialiased frame for the same pixels (measured:
  // 28_decisions_rendering_layers.md).
  if (v_alpha < 0.01 || r2 > 1.0) discard;

  // Sphere normal for lighting
  vec3 normal = vec3(coord.x, -coord.y, sqrt(1.0 - r2));

  // Blinn-Phong (FULL_LIGHTING), white specular of exponent 32 (five
  // squarings) and weight 0.3.
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float specular = max(dot(normal, u_halfDir), 0.0);
  specular *= specular; specular *= specular; specular *= specular;
  specular *= specular; specular *= specular;
  vec3 litColor = v_color * (${FULL_AMBIENT_GLSL} + ${FULL_DIFFUSE_GLSL} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = vec4(shadedColor, v_alpha * v_fogOpacity);
}
`;
var HP_FS_FULL_NO_DEPTH = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

// Pixels per unit of (1 - r^2) / 2 across the disc rim: one pixel wide from a
// radius of four pixels, narrower below so the smallest points stay crisp.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // The cases in which HP_FS_FULL discards, as a fragment that blends to
  // nothing: a hidden point and the sprite corners outside the disc.
  bool covered = v_alpha >= 0.01 && coverage > 0.0;

  vec3 normal = vec3(coord.x, -coord.y, sqrt(max(1.0 - r2, 0.0)));
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float specular = max(dot(normal, u_halfDir), 0.0);
  specular *= specular; specular *= specular; specular *= specular;
  specular *= specular; specular *= specular;
  vec3 litColor = v_color * (${FULL_AMBIENT_GLSL} + ${FULL_DIFFUSE_GLSL} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = covered ? vec4(shadedColor, v_alpha * v_fogOpacity * coverage) : vec4(0.0);
}
`;
var HP_VS_LIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
${POINT_SPRITE_GLSL}

// Alpha in source order, one R8 texel a point, as a linear texture
// (rendering/linear-texture.js), for alpha-only updates.
uniform lowp sampler2DArray u_alphaTex;
uniform ivec2 u_alphaLayout;
uniform bool u_useAlphaTex;
// The store order's slot map (slot -> source point), R32UI, so the alpha of
// a point drawn from a reordered store is found exactly at any index. Slots
// from u_orderedSlots on hold their own point (rendering/high-perf/
// store-order.js); 0 for a store in source order.
uniform highp usampler2DArray u_lodIndexTex;
uniform ivec2 u_lodIndexLayout;
uniform int u_orderedSlots;
// The first slot of the store segment drawn: gl_VertexID counts from it
// (rendering/high-perf/point-store-segments.js).
uniform int u_slotBase;
// Which cells this pass draws, by the layer their color's alpha byte names
// (alpha-visibility.js): 0 every one; 1 the grey beneath the colored cells
// (BENEATH_ALPHA_BYTE, 254); 2 the colored cells (255); 3 the cells not read
// (UNREAD_ALPHA_BYTE, 253). A field with lower layers is drawn a layer a
// pass, bottom first (3, 1, 2), so each lies over the one before in 2-D
// blending and wins depth ties in 3-D, at every level of detail and culled
// range.
uniform int u_drawPass;
// The color of a cell not read: the background's, faded toward the grey
// for 0 (rendering/read-cell-layer.js, unreadCellColor). Its own RGB bytes
// are not drawn.
uniform vec3 u_unreadColor;
// The grey of the cells beneath (no value: a gene's 0, a missing value), made
// from the background (rendering/read-cell-layer.js, zeroCellColor). Their
// own RGB bytes are not drawn.
uniform vec3 u_zeroColor;
// The cells of this draw lie beneath the others (pass 1, or a figure's first
// range): with depth tested, each yields to any cell up to one drawn point
// diameter behind it, so an expressing cell on the same surface as the grey
// around it shows in 3-D too, while a cell well in front still occludes.
uniform bool u_yieldDepth;
${LINEAR_TEXEL_GLSL}
${UNPLACED_GLSL}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;

void main() {
  // The same two products as HP_VS_FULL, not one model-view-projection
  // product: depth is then bit-identical across qualities, so the same point
  // wins every near-tie in every quality.
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled
  float alpha;
  if (u_useAlphaTex) {
    // Integer addressing throughout: a float index loses exactness at 2^24.
    int slot = u_slotBase + gl_VertexID;
    int origIdx = slot < u_orderedSlots
      ? int(texelFetch(u_lodIndexTex, linearTexel(slot, u_lodIndexLayout), 0).r)
      : slot;
    alpha = texelFetch(u_alphaTex, linearTexel(origIdx, u_alphaLayout), 0).r;
  } else {
    alpha = a_color.a;
  }

  // The same sprite as HP_VS_FULL and HP_VS_HIGHLIGHT (one GLSL function,
  // rendering/point-sprite.js). Shader quality selects shading, never
  // geometry: a higher ceiling here would make "light" and "ultralight" draw
  // larger points than "full" at close range, which is both a different
  // picture and, because point area is quadratic in the size, more fill
  // (measured: 28_decisions_rendering_layers.md).
  gl_PointSize = pointSpriteSize(eyeDepth);

  // Reject invisible points before rasterisation — see HP_VS_FULL. This shader
  // also backs the ultralight program, whose fragment shader does not discard,
  // so without the clip rejection a hidden point still writes depth and
  // occludes the visible points behind it.
  if (u_yieldDepth) {
    // One drawn diameter in eye units at this depth (u_pointScale: pixels
    // per world unit at unit depth, over 100), the depth moved back by it.
    float diameter = gl_PointSize * eyeDepth / max(100.0 * u_pointScale, 1e-6);
    vec4 yielded = u_projectionMatrix * vec4(eyePos.xy, eyePos.z - diameter, 1.0);
    gl_Position.z = clamp(yielded.z / yielded.w, -1.0, 1.0) * gl_Position.w;
  }
  // The layer byte, exact: a normalized byte is k / 255.
  int layer = int(a_color.a * 255.0 + 0.5);
  if (alpha < 0.01 || isUnplacedPosition(a_position)
    || (u_drawPass == 1 && layer != 254) || (u_drawPass == 2 && layer != 255) || (u_drawPass == 3 && layer != 253)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  // The passes of the lower layers draw them in their own colors (a
  // figure's raster bakes those into the colors and draws in pass 0).
  v_color = u_drawPass == 3 ? u_unreadColor : (u_drawPass == 1 ? u_zeroColor : a_color.rgb);
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`;
var HP_FS_LIGHT = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  // One discard for a hidden point and a corner outside the disc; see
  // HP_FS_FULL.
  if (v_alpha < 0.01 || r2 > 1.0) discard;

  fragColor = vec4(v_color, v_alpha);
}
`;
var HP_FS_LIGHT_NO_DEPTH = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

// Pixels per unit of (1 - r^2) / 2 across the disc rim: one pixel wide from a
// radius of four pixels, narrower below so the smallest points stay crisp.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // The cases in which HP_FS_LIGHT discards, as a fragment that blends to
  // nothing: a hidden point (the vertex shader has already moved it out of
  // the clip volume, so this is the second line of defence), and the sprite
  // corners outside the disc. The rim between is antialiased; see
  // HP_FS_FULL_NO_DEPTH.
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(v_color, v_alpha * coverage) : vec4(0.0);
}
`;
var HP_FS_ULTRALIGHT = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, v_alpha);
}
`;
var SCULPTED = Object.freeze({
  // Hemisphere ambient: a neutral sky above, a dimmer bounce below.
  skyAmbient: 1,
  groundAmbient: 0.5,
  ambientWeight: 0.25,
  // Wrapped Lambert keyed to the scene light: the terminator rolls off softly
  // instead of cutting the sphere in half.
  wrap: 0.25,
  diffuseWeight: 1,
  // The sphere's own occlusion toward its silhouette: what makes a dot read as
  // a ball and separates touching balls in a dense cloud.
  edgeOcclusion: 0.22,
  // A soft gloss in place of a hard white specular. It fades out on sprites
  // too small to show it, where it would only glitter.
  sheenWeight: 0.45
});
var GLSL_FLOAT = (value) => {
  const text = String(value);
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
};
var SCULPTED_SHADING_GLSL = `
// Pixels per unit of (1 - r^2) / 2 across the disc rim; see
// HP_FS_FULL_NO_DEPTH.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

// Sculpted lighting of one sphere normal, in linear light, before the
// centre normalisation. Mirrors sculptedCenterShade() in JavaScript.
float sculptedShade(vec3 normal, out float sky) {
  sky = normal.y * 0.5 + 0.5;
  float ambient = mix(${GLSL_FLOAT(SCULPTED.groundAmbient)}, ${GLSL_FLOAT(SCULPTED.skyAmbient)}, sky);
  float wrapped = clamp(
    (dot(normal, u_lightDir) + ${GLSL_FLOAT(SCULPTED.wrap)}) * ${GLSL_FLOAT(1 / (1 + SCULPTED.wrap))},
    0.0,
    1.0
  );
  float occlusion = mix(${GLSL_FLOAT(SCULPTED.edgeOcclusion)}, 1.0, smoothstep(0.0, 0.75, normal.z));
  return (
    ${GLSL_FLOAT(SCULPTED.ambientWeight)} * ambient +
    ${GLSL_FLOAT(SCULPTED.diffuseWeight)} * wrapped * wrapped
  ) * occlusion;
}

vec3 sculptedColor(vec2 coord, float r2) {
  // The antialiased rim reaches half a pixel past the silhouette; there the
  // normal is the silhouette's own, not a longer-than-unit vector that would
  // light the rim brighter than the sphere.
  vec2 disc = coord * inversesqrt(max(r2, 1.0));
  vec3 normal = vec3(disc.x, -disc.y, sqrt(max(1.0 - r2, 0.0)));
  vec3 albedo = v_color * v_color;
  float sky;
  float shade = sculptedShade(normal, sky) * u_invCenterShade;
  // Gloss: exponent 32 (five squarings), faded in between sprite radii of two
  // and six pixels.
  float gloss = max(dot(normal, u_halfDir), 0.0);
  gloss *= gloss; gloss *= gloss; gloss *= gloss; gloss *= gloss; gloss *= gloss;
  gloss *= smoothstep(2.0, 6.0, v_radiusPx);
  vec3 lit = albedo * shade
    + (${GLSL_FLOAT(SCULPTED.sheenWeight)} * gloss) * mix(vec3(1.0), albedo, 0.25);
  vec3 shaded = sqrt(lit);
  return mix(u_fogColor, mix(v_color, shaded, u_lightingStrength), v_fogT);
}
`;
var HP_FS_SCULPTED = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogT;

uniform float u_lightingStrength;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;
uniform float u_invCenterShade;
uniform float u_coverageFloor;

out vec4 fragColor;
${SCULPTED_SHADING_GLSL}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // One discard: a hidden point (second line of defence behind HP_VS_FULL's
  // clip-volume rejection) and a fragment outside the disc's coverage.
  if (v_alpha < 0.01 || coverage <= u_coverageFloor) discard;
  fragColor = vec4(
    sculptedColor(coord, r2),
    u_coverageFloor > 0.0 ? 1.0 : coverage
  );
}
`;
var HP_FS_SCULPTED_NO_DEPTH = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogT;

uniform float u_lightingStrength;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;
uniform float u_invCenterShade;

out vec4 fragColor;
${SCULPTED_SHADING_GLSL}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(sculptedColor(coord, r2), v_alpha * coverage) : vec4(0.0);
}
`;
function sculptedCenterShade(lightDir) {
  const sky = 0.5;
  const ambient = SCULPTED.groundAmbient + (SCULPTED.skyAmbient - SCULPTED.groundAmbient) * sky;
  const wrapped = Math.min(
    1,
    Math.max(0, (lightDir[2] + SCULPTED.wrap) / (1 + SCULPTED.wrap))
  );
  return SCULPTED.ambientWeight * ambient + SCULPTED.diffuseWeight * wrapped * wrapped;
}
function writePointShaderFrame(target, viewMatrix, modelMatrix, lightDir, viewportHeight, fov) {
  const out = target.modelView;
  const a = viewMatrix;
  const b = modelMatrix;
  for (let column = 0; column < 4; column++) {
    const b0 = b[column * 4];
    const b1 = b[column * 4 + 1];
    const b2 = b[column * 4 + 2];
    const b3 = b[column * 4 + 3];
    out[column * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[column * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[column * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[column * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  const hx = lightDir[0];
  const hy = lightDir[1];
  const hz = lightDir[2] + 1;
  const length = Math.hypot(hx, hy, hz);
  const half = target.halfDir;
  if (length > 0) {
    half[0] = hx / length;
    half[1] = hy / length;
    half[2] = hz / length;
  } else {
    half[0] = 0;
    half[1] = 0;
    half[2] = 1;
  }
  target.invCenterShade = 1 / sculptedCenterShade(lightDir);
  return pointScaleFor(viewportHeight, fov);
}
var HIGHLIGHT_STYLES_BY_QUALITY = Object.freeze({
  full: Object.freeze({ scale: 1.75, ringWidth: 0.42, haloStrength: 0.65, haloShape: 0, ringStyle: 0, animated: true }),
  sculpted: Object.freeze({ scale: 1.75, ringWidth: 0.42, haloStrength: 0.65, haloShape: 0, ringStyle: 0, animated: false }),
  light: Object.freeze({ scale: 1.7, ringWidth: 0.44, haloStrength: 0.6, haloShape: 0, ringStyle: 1, animated: false }),
  ultralight: Object.freeze({ scale: 1.65, ringWidth: 0.46, haloStrength: 0.55, haloShape: 0.35, ringStyle: 2, animated: false })
});
var HIGHLIGHT_COLOR = Object.freeze([0.4, 0.85, 1]);
var HIGHLIGHT_RING_BLACK = Object.freeze(
  /** @type {[number, number, number]} */
  [0, 0, 0]
);
var HIGHLIGHT_RING_WHITE = Object.freeze(
  /** @type {[number, number, number]} */
  [1, 1, 1]
);
var linearChannel = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
function highlightRingColorFor(dotColor) {
  const luminance = 0.2126 * linearChannel(dotColor[0]) + 0.7152 * linearChannel(dotColor[1]) + 0.0722 * linearChannel(dotColor[2]);
  return (luminance + 0.05) ** 2 >= 0.05 * 1.05 ? HIGHLIGHT_RING_BLACK : HIGHLIGHT_RING_WHITE;
}
var HIGHLIGHT_RING_COLOR = highlightRingColorFor(HIGHLIGHT_COLOR);
var HIGHLIGHT_RING_INNER_GAP = 1.08;
var HIGHLIGHT_RING_RATIO = 1.65;
function highlightRingRadii({ scale, ringWidth }) {
  let inner = HIGHLIGHT_RING_INNER_GAP / scale;
  const tube = (inner * HIGHLIGHT_RING_RATIO - inner) * 0.5 * (0.5 + ringWidth * 0.5);
  let outer = inner + tube * 2;
  if (outer > 0.95) {
    const bound = 0.95 / outer;
    inner *= bound;
    outer *= bound;
  }
  return { inner: inner * scale, outer: outer * scale };
}
function highlightGlowAt(timeSeconds) {
  return 0.5 + 0.5 * Math.sin(timeSeconds * 4);
}
var HP_VS_HIGHLIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed - we only use alpha for visibility

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
${POINT_SPRITE_GLSL}
uniform float u_highlightScale; // How much larger the highlight ring is (e.g., 1.5)
// The GPU's largest point (ALIASED_POINT_SIZE_RANGE[1]), in the pixels drawn into.
uniform float u_gpuPointSizeMax;

${FOG_GLSL}
${UNPLACED_GLSL}
flat out float v_alpha;
flat out float v_fogOpacity; // The opacity fog leaves this ring (fog-shaders.js)

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // The dot's own sprite (rendering/point-sprite.js: the same function as
  // the point shaders), so the ring sits on the dot at every depth.
  float dotSize = pointSpriteSize(eyeDepth);

  // The ring is a constant multiple of the dot, within the GPU's largest
  // point (u_gpuPointSizeMax: asking for more is undefined, not clamped).
  gl_PointSize = clamp(dotSize * u_highlightScale, 1.0, u_gpuPointSizeMax);

  v_fogOpacity = fogOpacity(fogTransmittance(length(eyePos.xyz)));

  // Reject unhighlighted points before rasterisation — see HP_VS_FULL. Zeroing
  // the size alone does not hide anything: the driver clamps it back to one
  // pixel, so the point is still assembled, rasterised and shaded.
  //
  // Two facts elsewhere make that harmless, and this shader relies on
  // neither. Both producers pack only points at or above MIN_VISIBLE_ALPHA_BYTE
  // — 3/255 = 0.0118, above this 0.01 threshold — so nothing can reach this
  // branch (highlight-renderer.js, and the figure-export path in
  // app/ui/modules/figure-export/utils/webgl-point-rasterizer.js); and both draw
  // sites run depthMask(false). A producer that stops compacting, or a pass that
  // starts writing depth, is then a change to those files and not to this one.
  if (a_color.a < 0.01 || isUnplacedPosition(a_position)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_alpha = a_color.a;
}
`;
var HP_FS_HIGHLIGHT = `#version 300 es
precision highp float;

flat in float v_alpha;
flat in float v_fogOpacity; // The opacity fog leaves this ring (HP_VS_HIGHLIGHT)

uniform vec3 u_highlightColor; // The dot (HIGHLIGHT_COLOR)
// The ring around it (highlightRingColorFor(u_highlightColor)): black around
// a light dot, so the pair reads against any coloring.
uniform vec3 u_highlightRingColor;
uniform float u_ringWidth;
uniform float u_haloStrength;
uniform float u_haloShape; // 0 = circle, 1 = square
uniform float u_highlightScale;
uniform float u_ringStyle; // 0 = 3D torus, 1 = flat circle, 2 = flat square
uniform float u_time; // For the ring shimmer
// The pulse: 0.5 + 0.5 sin(4 t), evaluated once per draw on the CPU.
uniform float u_glow;


// Lighting uniforms (same as HP_FS_FULL)
uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float rCircle = length(coord);
  float rSquare = max(abs(coord.x), abs(coord.y));
  float baseR = (u_ringStyle > 1.5) ? rSquare : rCircle;
  float shapeR = (u_ringStyle > 1.5) ? rSquare : mix(rCircle, rSquare, u_haloShape);

  if (shapeR > 1.0) discard;

  // === CONSTANT MULTIPLIER RING GEOMETRY ===
  // Inner radius = where the dot ends (1/highlightScale) with small gap
  // Outer radius = innerRadius * constant ring ratio
  // This ensures consistent proportions at ALL zoom levels

  // highlightRingRadii() is this geometry for a vector figure.
  const float INNER_GAP = ${HIGHLIGHT_RING_INNER_GAP.toFixed(2)};      // 8% gap between dot edge and ring inner edge
  const float RING_RATIO = ${HIGHLIGHT_RING_RATIO.toFixed(2)};     // Outer radius is 65% larger than inner radius

  // The dot occupies radius (1/u_highlightScale) in normalized sprite coords
  // Add small gap so ring doesn't touch the dot
  float innerRadius = (1.0 / u_highlightScale) * INNER_GAP;

  // Outer radius is constant multiple of inner
  float outerRadius = innerRadius * RING_RATIO;

  // Derive tube geometry from inner/outer
  float tubeRadius = (outerRadius - innerRadius) * 0.5;
  float majorRadius = innerRadius + tubeRadius;

  // Apply u_ringWidth as a scaling factor on tube thickness
  tubeRadius *= (0.5 + u_ringWidth * 0.5);
  // Recalculate outer after adjusting tube
  outerRadius = innerRadius + tubeRadius * 2.0;
  majorRadius = innerRadius + tubeRadius;

  // Clamp to ensure ring stays within sprite bounds
  if (outerRadius > 0.95) {
    float scale = 0.95 / outerRadius;
    innerRadius *= scale;
    outerRadius *= scale;
    tubeRadius *= scale;
    majorRadius = innerRadius + tubeRadius;
  }

  float radial = length(coord);
  float aa = fwidth(radial) * 1.5 + 0.003;

  // The dot radius in normalized coords (where the actual dot ends)
  float dotRadius = 1.0 / u_highlightScale;

  if (u_ringStyle < 0.5) {
    // ============================================
    // 3D TORUS RING + DOT - Full quality
    // Renders BOTH the dot and the ring around it
    // ============================================

    // Check if we're inside the DOT area (extends to innerRadius to fill gap)
    // This prevents underlying main point colors bleeding through when zoomed in close
    bool inDot = radial < innerRadius;

    // Distance from the ring's center circle
    float distFromRing = abs(radial - majorRadius);

    // Check if we're within the ring tube
    bool inRing = distFromRing <= tubeRadius + aa * 2.0;

    // Discard if outside both dot and ring (no outer glow)
    if (!inDot && !inRing) discard;

    vec3 finalColor;
    float finalAlpha;

    if (inDot) {
      // === RENDER THE DOT (including gap region up to innerRadius) ===
      // Scale coord to dot's local space, same approach as HP_FS_FULL
      // Gap region (radial > dotRadius) gets z=0 edge lighting naturally
      vec2 localCoord = coord / dotRadius;
      float localR2 = dot(localCoord, localCoord);
      float z = sqrt(max(1.0 - localR2, 0.0));
      vec3 normal = vec3(localCoord.x, -localCoord.y, z);

      // Glow factor: 0.0 = normal (matches unhighlighted cells), 1.0 = full glow
      float glowFactor = u_glow;

      // === BASE LIGHTING (exactly matches HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, u_lightDir), 0.0);
      float ambient = ${FULL_AMBIENT_GLSL};
      float diffuse = ${FULL_DIFFUSE_GLSL} * NdotL;
      float specularBase = max(dot(normal, u_halfDir), 0.0);
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase;
      float specular = specularBase * 0.3;

      // Lit color (same formula as HP_FS_FULL)
      vec3 litColor = u_highlightColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      // Extra brightness
      float extraBrightness = glowFactor * 0.3;
      // Extra specular
      float extraSpecular = glowFactor * 0.2 * specularBase;
      // Rim glow
      float rimFactor = 1.0 - z;
      float rimGlow = glowFactor * rimFactor * 0.25;
      // Subtle emission
      float emission = glowFactor * 0.1;

      vec3 dotColor = baseColor * (1.0 + extraBrightness) + vec3(extraSpecular) + u_highlightColor * (rimGlow + emission);

      finalColor = dotColor;

      // Hard edge at dot boundary - no soft fade
      finalAlpha = (radial <= dotRadius) ? v_alpha : 0.0;

    } else if (inRing) {
      // === RENDER THE RING ===
      // Calculate the "height" on the torus surface (circular cross-section)
      float tubeT = distFromRing / tubeRadius;
      float zNorm = sqrt(max(1.0 - tubeT * tubeT, 0.0));

      // Normal calculation for torus surface
      vec2 radialDir = coord / max(radial, 0.001);
      float radialSign = sign(radial - majorRadius);

      vec3 normal = normalize(vec3(
        radialDir * radialSign * tubeT,
        zNorm
      ));

      // Glow factor synced with dot (0.0 = dim, 1.0 = full glow)
      float glowFactor = u_glow;
      float shimmer = 0.5 + 0.5 * sin(u_time * 8.0 + radial * 3.14159);

      // === BASE LIGHTING (same formula as HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, u_lightDir), 0.0);
      float ambient = ${FULL_AMBIENT_GLSL};
      float diffuse = ${FULL_DIFFUSE_GLSL} * NdotL;
      float specularBase = max(dot(normal, u_halfDir), 0.0);
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase;
      float specular = specularBase * 0.3;

      // Lit ring color (same formula as HP_FS_FULL): a black ring keeps
      // only its specular sheen.
      vec3 litColor = u_highlightRingColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightRingColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      float facing = 1.0 - max(normal.z, 0.0);
      float fresnel = facing * facing * facing;
      vec3 warmWhite = vec3(1.0, 0.98, 0.95);

      // Extra brightness
      float extraBrightness = glowFactor * 0.4;
      // Extra specular with shimmer
      float extraSpec = glowFactor * shimmer * specularBase * 0.5;
      // Rim glow
      float rimGlow = glowFactor * fresnel * 0.4;
      // Subtle emission
      float emission = glowFactor * 0.15;

      vec3 ringColor = baseColor * (1.0 + extraBrightness) + warmWhite * extraSpec;
      ringColor = mix(ringColor, u_highlightRingColor * 1.3, rimGlow);
      ringColor += u_highlightRingColor * emission;

      // Hard edge on tube boundary - no soft fade that creates white outline
      bool withinTube = distFromRing <= tubeRadius;

      finalColor = ringColor;
      finalAlpha = withinTube ? (0.95 * v_alpha) : 0.0;
    }

    if (finalAlpha < 0.01) discard;

    // Fog thins the ring toward whatever is behind it (fog-shaders.js).
    fragColor = vec4(finalColor, v_fogOpacity * finalAlpha);
    return;
  }

  // ============================================
  // FLAT RING + DOT VARIANTS (Light/Ultralight quality)
  // Minimal cost: flat colors, no shading calculations
  // High-contrast center for popup effect
  // ============================================

  // Center highlight radius (40% of dot for visible pop)
  float centerRadius = innerRadius * 0.4;

  // CENTER - high contrast bright spot (circle or square based on mode)
  if (baseR < centerRadius) {
    // Bright center: boost highlight color
    vec3 centerColor = min(u_highlightColor * 1.4 + vec3(0.15), vec3(1.0));
    fragColor = vec4(centerColor, v_alpha);
    return;
  }

  // DOT AREA - standard highlight color
  if (baseR < innerRadius) {
    fragColor = vec4(u_highlightColor, v_alpha);
    return;
  }

  // RING AREA - flat fill in the ring color
  if (baseR <= outerRadius) {
    fragColor = vec4(u_highlightRingColor, v_alpha * 0.95);
    return;
  }

  discard;
}
`;

// assets/js/rendering/high-perf/gl-point-draw-state.js
function enterOpaquePointBlending(gl, multisampled) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  if (multisampled) {
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  } else {
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  }
}

// assets/js/rendering/high-perf/point-store-segments.js
var POINT_STORE_SEGMENT_POINTS = MAX_VERTICES_PER_DRAW;
function planStoreSegments(pointCount, segmentPoints = POINT_STORE_SEGMENT_POINTS) {
  requireSegmentPoints(segmentPoints);
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError(`A point store needs a non-negative slot count, not ${pointCount}.`);
  }
  const segments = [];
  for (let first = 0; first < pointCount; first += segmentPoints) {
    segments.push(Object.freeze({ first, count: Math.min(segmentPoints, pointCount - first) }));
  }
  return Object.freeze(segments);
}
function forEachSegmentRange(segments, first, count, visit) {
  if (count <= 0) return 0;
  const end = first + count;
  const size = segments[0].count;
  let index = Math.min(segments.length - 1, Math.floor(first / size));
  let pieces = 0;
  for (; index < segments.length; index++) {
    const segment = segments[index];
    const segmentEnd = segment.first + segment.count;
    if (segmentEnd <= first) continue;
    if (segment.first >= end) break;
    const from = Math.max(first, segment.first);
    const to = Math.min(end, segmentEnd);
    visit(index, from - segment.first, to - from);
    pieces++;
  }
  return pieces;
}
function requireSegmentPoints(segmentPoints) {
  if (!Number.isSafeInteger(segmentPoints) || segmentPoints <= 0) {
    throw new RangeError(`A point store segment holds a positive number of slots, not ${segmentPoints}.`);
  }
}
var PointStore = class {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} [segmentPoints=POINT_STORE_SEGMENT_POINTS]
   */
  constructor(gl, segmentPoints = POINT_STORE_SEGMENT_POINTS) {
    requireSegmentPoints(segmentPoints);
    this.gl = gl;
    this.segmentPoints = segmentPoints;
    this.segments = [];
    this.pointCount = 0;
    this.bytesPerPoint = 0;
    this.deleted = false;
  }
  /** Bytes of the points the store holds (its slots, `pointCount`). */
  get byteLength() {
    return this.pointCount * this.bytesPerPoint;
  }
  /**
   * Bytes of every segment's storage together: `byteLength`, and more while
   * a growth toward a known target has room for it (`resize`'s `capacity`).
   * What the store costs on the GPU.
   */
  get allocatedByteLength() {
    let slots = 0;
    for (const segment of this.segments) slots += segment.capacity;
    return slots * this.bytesPerPoint;
  }
  /**
   * (Re)allocate the store for `pointCount` points of `bytesPerPoint` bytes,
   * every segment's storage made by `allocate(refusal, run)` (the renderer's
   * `_allocateGpu`, which reads the error back and retries a refusal for
   * memory). With `data` (a typed array of exactly those bytes) each segment
   * is made holding its share. Segments of the previous layout that do not
   * fit the new one are deleted. A refusal leaves the buffers made so far in
   * the store (its point count 0), for its owner to retire with it.
   *
   * @param {number} pointCount
   * @param {number} bytesPerPoint
   * @param {number} usage
   * @param {(refusal: string, run: () => void) => void} allocate
   * @param {string} refusal - Names the store in a refused allocation.
   * @param {ArrayBufferView|null} [data]
   * @returns {number} The store's byte length.
   */
  allocate(pointCount, bytesPerPoint, usage, allocate, refusal, data = null) {
    const gl = this.gl;
    if (data !== null && data.byteLength !== pointCount * bytesPerPoint) {
      throw new RangeError(`${refusal}: the data holds ${formatCountOf(data.byteLength, "byte")}, not ${formatCount(pointCount * bytesPerPoint)}.`);
    }
    const plan = planStoreSegments(pointCount, this.segmentPoints);
    const kept = this.segments;
    this.segments = [];
    this.pointCount = 0;
    this.bytesPerPoint = bytesPerPoint;
    try {
      for (let index = 0; index < plan.length; index++) {
        const { first, count } = plan[index];
        const buffer = index < kept.length ? kept[index].buffer : gl.createBuffer();
        if (index < kept.length) kept[index] = null;
        if (!buffer) throw new Error(`${refusal}: no buffer could be created.`);
        this.segments.push({ buffer, first, count, capacity: count });
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const bytes = count * bytesPerPoint;
        allocate(`${refusal} (segment ${index + 1} of ${plan.length}, ${formatCountOf(bytes, "byte")})`, () => {
          if (data === null) {
            gl.bufferData(gl.ARRAY_BUFFER, bytes, usage);
          } else {
            const elements = bytesPerPoint / data.BYTES_PER_ELEMENT;
            gl.bufferData(gl.ARRAY_BUFFER, data, usage, first * elements, count * elements);
          }
        });
      }
      this.pointCount = pointCount;
    } finally {
      for (const segment of kept) if (segment !== null) gl.deleteBuffer(segment.buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    return this.byteLength;
  }
  /**
   * Give the store `pointCount` slots, keeping the bytes of every slot it
   * holds below both counts (cells added or removed in place, see the module
   * comment, "Growing a store"). Segments whose size does not change are
   * kept as they are; the one segment that changes size (the old last one,
   * when partial, or the new last one) is made anew and its kept slots copied
   * over on the GPU (`copyBufferSubData`); segments past the new count are
   * deleted, new ones allocated (empty: the caller writes the new slots). A
   * segment whose storage already holds its new count (a cut, or a growth
   * toward the `capacity` it was made for) keeps its buffer: nothing is
   * allocated, copied or read back. A segment that must be made anew is made
   * for `capacity` (the target of a growth under way), so the steps after it
   * only write. A refusal deletes what this call made and leaves the store
   * as it was.
   *
   * @param {number} pointCount
   * @param {number} usage
   * @param {(refusal: string, run: () => void) => void} allocate - As for `allocate`.
   * @param {string} refusal
   * @param {number} [capacity=pointCount] - Slots a growth under way reaches.
   * @returns {number} The store's byte length.
   */
  resize(pointCount, usage, allocate, refusal, capacity = pointCount) {
    const gl = this.gl;
    const bytesPerPoint = this.bytesPerPoint;
    if (!(bytesPerPoint > 0)) throw new Error(`${refusal}: a store is allocated before it is resized.`);
    if (!Number.isSafeInteger(capacity) || capacity < pointCount) {
      throw new RangeError(`${refusal}: a capacity of ${capacity} slots does not hold ${formatCountOf(pointCount, "point")}.`);
    }
    const plan = planStoreSegments(pointCount, this.segmentPoints);
    const reach = planStoreSegments(capacity, this.segmentPoints);
    const old = this.segments;
    const next = [];
    const made = [];
    try {
      for (let index = 0; index < plan.length; index++) {
        const { first, count } = plan[index];
        const previous = old[index] ?? null;
        if (previous !== null && previous.capacity >= count) {
          next.push(previous.count === count ? previous : { ...previous, count });
          continue;
        }
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error(`${refusal}: no buffer could be created.`);
        made.push(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const slots = reach[index].count;
        const bytes = slots * bytesPerPoint;
        allocate(`${refusal} (segment ${index + 1} of ${plan.length}, ${formatCountOf(bytes, "byte")})`, () => {
          gl.bufferData(gl.ARRAY_BUFFER, bytes, usage);
        });
        if (previous !== null) {
          gl.bindBuffer(gl.COPY_READ_BUFFER, previous.buffer);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer);
          gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, Math.min(previous.count, count) * bytesPerPoint);
          gl.bindBuffer(gl.COPY_READ_BUFFER, null);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
        }
        next.push({ buffer, first, count, capacity: slots });
      }
    } catch (error) {
      for (const buffer of made) gl.deleteBuffer(buffer);
      throw error;
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    const kept = new Set(next.map((segment) => segment.buffer));
    for (const segment of old) if (!kept.has(segment.buffer)) gl.deleteBuffer(segment.buffer);
    this.segments = next;
    this.pointCount = pointCount;
    return this.byteLength;
  }
  /**
   * Write `data` (a typed array of whole points) into the store from point
   * `firstPoint`, one `bufferSubData` a segment it covers.
   *
   * @param {ArrayBufferView} data
   * @param {number} [firstPoint=0]
   */
  write(data, firstPoint = 0) {
    const gl = this.gl;
    const elements = this.bytesPerPoint / data.BYTES_PER_ELEMENT;
    const points = data.length / elements;
    if (!Number.isInteger(points) || firstPoint < 0 || firstPoint + points > this.pointCount) {
      throw new RangeError(`A point store of ${formatCountOf(this.pointCount, "point")} cannot take ${formatCountOf(data.length, "element")} at point ${firstPoint}.`);
    }
    try {
      forEachSegmentRange(this.segments, firstPoint, points, (index, localFirst, localCount) => {
        const segment = this.segments[index];
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          localFirst * this.bytesPerPoint,
          data,
          (segment.first + localFirst - firstPoint) * elements,
          localCount * elements
        );
      });
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }
  /**
   * Read the store back into `out` (a typed array of whole points, from
   * point 0): tests and diagnostics only (`getBufferSubData` waits for the
   * GPU).
   *
   * @param {ArrayBufferView} out
   * @returns {ArrayBufferView} `out`
   */
  read(out) {
    const gl = this.gl;
    const elements = this.bytesPerPoint / out.BYTES_PER_ELEMENT;
    try {
      for (const segment of this.segments) {
        const count = Math.min(segment.count, out.length / elements - segment.first);
        if (count <= 0) break;
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out, segment.first * elements, count * elements);
      }
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    return out;
  }
  /**
   * Delete every segment's buffer. A deletion that throws leaves the
   * segments not yet deleted in place, so a retry deletes exactly those.
   */
  delete() {
    while (this.segments.length > 0) {
      this.gl.deleteBuffer(this.segments[this.segments.length - 1].buffer);
      this.segments.pop();
    }
    this.pointCount = 0;
    this.deleted = true;
  }
};
var SegmentedVertexArray = class {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.vaos = [];
    this.segments = [];
    this.positionBuffers = [];
    this.deleted = false;
  }
  /**
   * Bind `positions` (and `colors`, a store with the same segments, or
   * null) into one VAO a segment, making or deleting VAOs to match.
   *
   * @param {PointStore} positions
   * @param {PointStore|null} colors
   * @param {number} dimension - Float32 components a position (1, 2 or 3).
   */
  setStores(positions, colors, dimension) {
    const gl = this.gl;
    requireMatchingSegments(positions, colors);
    while (this.vaos.length > positions.segments.length) gl.deleteVertexArray(this.vaos.pop());
    while (this.vaos.length < positions.segments.length) {
      const vao = gl.createVertexArray();
      if (!vao) throw new Error("A point store could not create its vertex array.");
      this.vaos.push(vao);
    }
    this.segments = positions.segments.map(({ first, count }) => ({ first, count }));
    this.positionBuffers = positions.segments.map((segment) => segment.buffer);
    try {
      for (let index = 0; index < this.vaos.length; index++) {
        gl.bindVertexArray(this.vaos[index]);
        gl.bindBuffer(gl.ARRAY_BUFFER, positions.segments[index].buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, dimension, gl.FLOAT, false, dimension * 4, 0);
        bindColorAttribute(gl, colors === null ? null : colors.segments[index].buffer, this.positionBuffers[index]);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }
  /**
   * Re-point attribute 1 of every segment's VAO at `colors` (null: off).
   *
   * @param {PointStore|null} colors
   */
  setColors(colors) {
    const gl = this.gl;
    if (colors !== null && colors.segments.length !== this.vaos.length) {
      throw new RangeError("A color store must have the segments of the positions it is drawn with.");
    }
    try {
      for (let index = 0; index < this.vaos.length; index++) {
        gl.bindVertexArray(this.vaos[index]);
        bindColorAttribute(gl, colors === null ? null : colors.segments[index].buffer, this.positionBuffers[index]);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }
  /**
   * Draw slots `[first, first + count)`: one draw a segment the range
   * covers, in slot order, after `beforeSegment(segmentFirstSlot)` (which
   * sets the shader's slot base). Leaves no VAO bound.
   *
   * @param {number} first
   * @param {number} count
   * @param {(segmentFirst: number) => void} beforeSegment
   * @param {(gl: WebGL2RenderingContext, first: number, count: number) => number} drawRange
   * @returns {number} Draw calls issued.
   */
  drawRange(first, count, beforeSegment, drawRange) {
    const gl = this.gl;
    let calls = 0;
    try {
      forEachSegmentRange(this.segments, first, count, (index, localFirst, localCount) => {
        gl.bindVertexArray(this.vaos[index]);
        beforeSegment(this.segments[index].first);
        calls += drawRange(gl, localFirst, localCount);
      });
    } finally {
      gl.bindVertexArray(null);
    }
    return calls;
  }
  /** Delete every VAO (a deletion that throws leaves the rest for a retry). */
  delete() {
    while (this.vaos.length > 0) {
      this.gl.deleteVertexArray(this.vaos[this.vaos.length - 1]);
      this.vaos.pop();
    }
    this.segments = [];
    this.positionBuffers = [];
    this.deleted = true;
  }
};
function bindColorAttribute(gl, buffer, positionBuffer) {
  if (buffer === null) {
    releaseVertexAttribute(gl, 1, positionBuffer);
    return;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
}
function requireMatchingSegments(positions, colors) {
  if (!(positions instanceof PointStore)) {
    throw new TypeError("A segmented vertex array needs a position store.");
  }
  if (colors === null) return;
  if (!(colors instanceof PointStore) || colors.segments.length !== positions.segments.length || colors.segments.some((segment, index) => segment.count !== positions.segments[index].count)) {
    throw new RangeError("A color store must have the segments of the positions it is drawn with.");
  }
}

// assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js
var DEFAULT_ALPHA_THRESHOLD = POINT_VISIBILITY_THRESHOLD;
function highlightValueToAlphaByte(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(
      "Figure-export highlight values must be exact Uint8 intensities."
    );
  }
  return value;
}
function buildHighlightOverlayBuffers({
  positions,
  dimension,
  highlightArray,
  transparency,
  lodMembership,
  drawOrder,
  alphaThreshold
}) {
  if (highlightArray === null) return null;
  const n = positions.length / dimension;
  const admittedIndices = drawnSequence(lodMembership, drawOrder);
  const candidateCount = admittedIndices?.length ?? n;
  let count = 0;
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
    const aByte = highlightValueToAlphaByte(highlightArray[i]);
    if (aByte < MIN_VISIBLE_ALPHA_BYTE) continue;
    const baseAlpha = transparency === null ? 1 : transparency[i];
    if (baseAlpha < alphaThreshold) continue;
    if (isUnplacedCell(positions, dimension, i)) continue;
    count++;
  }
  if (count <= 0) return null;
  const outPos = allocateLargeArray(Float32Array, count * dimension);
  const outCol = allocateLargeArray(Uint8Array, count * 4);
  let cursor = 0;
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
    const aByte = highlightValueToAlphaByte(highlightArray[i]);
    if (aByte < MIN_VISIBLE_ALPHA_BYTE) continue;
    const baseAlpha = transparency === null ? 1 : transparency[i];
    if (baseAlpha < alphaThreshold) continue;
    if (isUnplacedCell(positions, dimension, i)) continue;
    const pi = i * dimension;
    const oi = cursor * dimension;
    for (let axis = 0; axis < dimension; axis++) {
      outPos[oi + axis] = positions[pi + axis];
    }
    const cj = cursor * 4;
    outCol[cj] = 255;
    outCol[cj + 1] = 255;
    outCol[cj + 2] = 255;
    outCol[cj + 3] = aByte;
    cursor++;
  }
  return { positions: outPos, colors: outCol, count, dimension };
}
var rasterContexts = /* @__PURE__ */ new Map();
function uploadPointPass(gl, positions, dimension, colors, count, label) {
  const pass = {
    positions: new PointStore(gl),
    colors: new PointStore(gl),
    arrays: new SegmentedVertexArray(gl)
  };
  const allocate = (refusal, run) => {
    run();
    const code = gl.getError();
    if (code !== gl.NO_ERROR) throw new RangeError(`${refusal} (WebGL error 0x${code.toString(16)}).`);
  };
  pass.positions.allocate(count, dimension * 4, gl.STATIC_DRAW, allocate, `${label} positions`, positions.subarray(0, count * dimension));
  pass.colors.allocate(count, 4, gl.STATIC_DRAW, allocate, `${label} colors`, colors.subarray(0, count * 4));
  pass.arrays.setStores(pass.positions, pass.colors, dimension);
  return pass;
}
function drawPointPass(pass, count, { unread = 0, beneath = 0 } = {}, { setYield = null, setUnread = null } = {}) {
  let first = 0;
  if (unread > 0 && setUnread !== null) {
    setUnread(true);
    pass.arrays.drawRange(0, unread, () => {
    }, drawPointsInSegments);
    setUnread(false);
    first = unread;
  }
  if (beneath > 0 && setYield !== null) {
    setYield(1);
    pass.arrays.drawRange(first, beneath, () => {
    }, drawPointsInSegments);
    setYield(0);
    first += beneath;
  }
  pass.arrays.drawRange(first, count - first, () => {
  }, drawPointsInSegments);
}
function resetRasterState(gl) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.useProgram(null);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  for (const unit of [gl.TEXTURE0, gl.TEXTURE1]) {
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }
  gl.activeTexture(gl.TEXTURE0);
}
function acquireRasterContext(antialias) {
  const existing = rasterContexts.get(antialias);
  if (existing !== void 0 && !existing.gl.isContextLost()) {
    resetRasterState(existing.gl);
    return existing;
  }
  if (typeof OffscreenCanvas !== "function") {
    throw new Error(
      "Figure-export WebGL2 rasterization requires OffscreenCanvas."
    );
  }
  const canvas = new OffscreenCanvas(1, 1);
  const gl = getWebgl2Context(canvas, antialias);
  const entry = { canvas, gl };
  rasterContexts.set(antialias, entry);
  return entry;
}
function getWebgl2Context(canvas, antialias) {
  let gl;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      // Multisampling is a property of the drawing buffer the user is looking
      // at, not an export preference. Requesting a fixed `true` here would
      // publish a smoother cloud than the screen ever drew (the difference is
      // a sizeable share of the pixels; measured: 36_decisions_figure_export.md).
      antialias,
      // Source-over blending stores premultiplied RGB in transparent pixels.
      // Publish that exact ownership to canvas compositing and PNG encoding;
      // declaring the buffer unpremultiplied would apply alpha a second time.
      premultipliedAlpha: true,
      // The frame leaves by `transferToImageBitmap`, which resolves and hands
      // over the drawing buffer; nothing reads it afterwards.
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });
  } catch (error) {
    throw new Error(
      `Figure-export WebGL2 context creation failed: ${error.message}`,
      { cause: error }
    );
  }
  if (!gl) {
    throw new Error("Figure export requires WebGL2 rasterization support.");
  }
  return gl;
}
function describeRasterContext(antialias) {
  if (typeof antialias !== "boolean") {
    throw new TypeError("A figure-export raster context is described for an exact antialiasing boolean.");
  }
  const { gl } = acquireRasterContext(antialias);
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL)),
    vendor: String(gl.getParameter(debug === null ? gl.VENDOR : debug.UNMASKED_VENDOR_WEBGL)),
    version: String(gl.getParameter(gl.VERSION)),
    attributes: gl.getContextAttributes(),
    samples: gl.getParameter(gl.SAMPLES),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES)
  };
}
function webgl2RasterAvailable() {
  try {
    acquireRasterContext(false);
    return true;
  } catch {
    return false;
  }
}
function shrinkRasterCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}
var spriteZoomLimit = null;
function exportSpriteZoomLimit() {
  if (spriteZoomLimit !== null) return spriteZoomLimit;
  const { gl } = acquireRasterContext(false);
  const driverMax = gpuPointSizeMax(gl);
  spriteZoomLimit = driverMax === null ? 1 : Math.max(1, driverMax / POINT_SPRITE_MAX_PX);
  return spriteZoomLimit;
}
function viewRectClipTransform(rect01) {
  const sx = 1 / rect01.width;
  const sy = 1 / rect01.height;
  const centerX = 2 * (rect01.x + rect01.width / 2) - 1;
  const centerY = 1 - 2 * (rect01.y + rect01.height / 2);
  const out = new Float32Array(16);
  out[0] = sx;
  out[5] = sy;
  out[10] = 1;
  out[15] = 1;
  out[12] = -centerX * sx;
  out[13] = -centerY * sy;
  return out;
}
function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}
function configureExactDrawingBuffer(gl, canvas, width, height) {
  const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  if (!(viewportDims instanceof Int32Array) || viewportDims.length < 2 || !Number.isSafeInteger(maxRenderbufferSize) || maxRenderbufferSize <= 0) {
    throw new Error(
      "Figure-export WebGL2 hardware limits are unavailable."
    );
  }
  const maxWidth = Math.min(viewportDims[0], maxRenderbufferSize);
  const maxHeight = Math.min(viewportDims[1], maxRenderbufferSize);
  if (width > maxWidth || height > maxHeight) {
    throw new RangeError(
      `Figure export ${width}×${height} exceeds this GPU's exact ${maxWidth}×${maxHeight} raster limit.`
    );
  }
  canvas.width = width;
  canvas.height = height;
  if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
    throw new RangeError(
      `Figure export could not allocate the exact ${width}×${height} WebGL2 drawing buffer.`
    );
  }
}
function pickShaderSources(shaderQuality, dimension) {
  const depth = dimension > NO_DEPTH_MAX_DIMENSION;
  if (shaderQuality === "ultralight") {
    return { vs: HP_VS_LIGHT, fs: HP_FS_ULTRALIGHT, quality: "ultralight", depth };
  }
  if (shaderQuality === "light") {
    return {
      vs: HP_VS_LIGHT,
      fs: depth ? HP_FS_LIGHT : HP_FS_LIGHT_NO_DEPTH,
      quality: "light",
      depth
    };
  }
  if (shaderQuality === "full") {
    return {
      vs: HP_VS_FULL,
      fs: depth ? HP_FS_FULL : HP_FS_FULL_NO_DEPTH,
      quality: "full",
      depth
    };
  }
  if (shaderQuality === "sculpted") {
    return {
      vs: HP_VS_FULL,
      fs: depth ? HP_FS_SCULPTED : HP_FS_SCULPTED_NO_DEPTH,
      quality: "sculpted",
      depth
    };
  }
  throw new RangeError(
    `Figure-export shaderQuality must be ${describeShaderQualities()}.`
  );
}
function packBuffers({
  positions,
  dimension,
  colors,
  colorAlpha,
  transparency,
  lodMembership,
  drawOrder,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
  alphaThreshold,
  pointLayers = null
}) {
  const alphaIsLayer = requireColorAlphaMeaning(colorAlpha, "Figure-export packed colors") === "layer";
  const n = positions.length / dimension;
  const admittedIndices = drawnSequence(lodMembership, drawOrder, alphaIsLayer ? colors : null, pointLayers?.readEveryLevel === true);
  const unreadRgb = pointLayers === null ? null : pointLayers.unreadColor.map((channel) => Math.round(channel * 255));
  const zeroRgb = pointLayers === null ? null : pointLayers.zeroColor.map((channel) => Math.round(channel * 255));
  const admittedCount = admittedIndices?.length ?? n;
  const outPositions = admittedIndices === null ? positions : allocateLargeArray(Float32Array, admittedCount * dimension);
  const outColors = allocateLargeArray(Uint8Array, admittedCount * 4);
  const mutedAlpha = selectionMutedOpacity;
  let cursor = 0;
  let unread = 0;
  let beneath = 0;
  for (let candidateIndex = 0; candidateIndex < admittedCount; candidateIndex++) {
    const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
    const pi = i * dimension;
    const ci = i * 4;
    const outPi = cursor * dimension;
    const outCi = cursor * 4;
    let r = colors[ci];
    let g = colors[ci + 1];
    let b = colors[ci + 2];
    const layer = colors[ci + 3];
    if (alphaIsLayer && layer === UNREAD_ALPHA_BYTE) {
      unread++;
      if (unreadRgb !== null) {
        r = unreadRgb[0];
        g = unreadRgb[1];
        b = unreadRgb[2];
      }
    } else if (alphaIsLayer && layer === BENEATH_ALPHA_BYTE) {
      beneath++;
      if (zeroRgb !== null) {
        r = zeroRgb[0];
        g = zeroRgb[1];
        b = zeroRgb[2];
      }
    }
    const baseAlpha = transparency !== null ? transparency[i] : alphaIsLayer ? 1 : layer / 255;
    let a = baseAlpha;
    if (admittedIndices !== null) {
      for (let axis = 0; axis < dimension; axis++) {
        outPositions[outPi + axis] = positions[pi + axis];
      }
    }
    if (emphasizeSelection && highlightArray !== null && highlightArray[i] < MIN_VISIBLE_ALPHA_BYTE) {
      r = 160;
      g = 160;
      b = 160;
      a *= mutedAlpha;
    }
    if (a < alphaThreshold) a = 0;
    const ao = Math.round(a * 255);
    outColors[outCi] = r;
    outColors[outCi + 1] = g;
    outColors[outCi + 2] = b;
    outColors[outCi + 3] = ao;
    cursor++;
  }
  return {
    positions: outPositions,
    colors: outColors,
    count: admittedCount,
    unread,
    beneath,
    dimension
  };
}
function exportPointSizeMax(gl, viewerCap, rasterScale) {
  const scaled = viewerCap * Math.max(1, rasterScale);
  const driverMax = gpuPointSizeMax(gl);
  return driverMax === null ? scaled : Math.min(scaled, driverMax);
}
function rasterizePointsWebgl({
  positions,
  dimension,
  colors,
  transparency = null,
  lodMembership = null,
  drawOrder = null,
  renderState,
  outputWidthPx,
  outputHeightPx,
  pointSizePx,
  overlayPoints = null,
  highlightArray = null,
  emphasizeSelection = false,
  selectionMutedOpacity = 0.15,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
  viewRect01,
  pointLayers = null
}) {
  requireFigurePointLayers(pointLayers, "Figure-export point layers");
  if (!renderState || typeof renderState !== "object") {
    throw new TypeError("Figure-export renderState is required.");
  }
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError(
      "Figure-export position dimension must be exactly 1, 2, or 3."
    );
  }
  if (!(positions instanceof Float32Array) || positions.length % dimension !== 0) {
    throw new TypeError(
      "Figure-export positions must be a Float32Array with dimension values per point."
    );
  }
  const pointCount = positions.length / dimension;
  assertLodMembership(lodMembership, { pointCount });
  assertDrawOrder(drawOrder, { pointCount });
  if (!(colors instanceof Uint8Array) || colors.length !== pointCount * 4) {
    throw new TypeError(
      "Figure-export colors must be a Uint8Array with exactly four values per point."
    );
  }
  if (transparency !== null && (!(transparency instanceof Uint8Array) || transparency.length !== pointCount)) {
    throw new TypeError(
      "Figure-export transparency must be null or one Uint8 value per point."
    );
  }
  if (highlightArray !== null && (!(highlightArray instanceof Uint8Array) || highlightArray.length !== pointCount)) {
    throw new TypeError(
      "Figure-export highlightArray must be null or one Uint8 value per point."
    );
  }
  for (const key of ["mvpMatrix", "viewMatrix", "modelMatrix", "projectionMatrix"]) {
    if (!(renderState[key] instanceof Float32Array) || renderState[key].length !== 16) {
      throw new TypeError(
        `Figure-export renderState.${key} must be a 16-value Float32Array.`
      );
    }
  }
  for (const key of [
    "fov",
    "pointSize",
    "sizeAttenuation",
    "lightingStrength",
    "fogDensity",
    "fogNear",
    "fogFar"
  ]) {
    if (!Number.isFinite(renderState[key])) {
      throw new TypeError(
        `Figure-export renderState.${key} must be a finite number.`
      );
    }
  }
  if (typeof renderState.antialias !== "boolean") {
    throw new TypeError(
      "Figure-export renderState.antialias must be an exact boolean."
    );
  }
  if (renderState.fogNear < 0 || renderState.fogFar < renderState.fogNear) {
    throw new RangeError(
      "Figure-export renderState fog range must satisfy 0 <= fogNear <= fogFar."
    );
  }
  for (const key of ["viewportWidth", "viewportHeight"]) {
    if (!Number.isInteger(renderState[key]) || renderState[key] <= 0) {
      throw new RangeError(
        `Figure-export renderState.${key} must be a positive integer.`
      );
    }
  }
  for (const key of ["fogColor", "lightDir", "cameraPosition"]) {
    const value = renderState[key];
    if (!(Array.isArray(value) || value instanceof Float32Array) || value.length !== 3 || Array.from(value).some((entry) => !Number.isFinite(entry))) {
      throw new TypeError(
        `Figure-export renderState.${key} must contain exactly three finite numbers.`
      );
    }
  }
  if (!Number.isFinite(renderState.pointSizeMax) || renderState.pointSizeMax <= 0) {
    throw new RangeError(
      "Figure-export renderState.pointSizeMax must be a finite positive number."
    );
  }
  pickShaderSources(renderState.shaderQuality, dimension);
  for (const [name, value] of [
    ["outputWidthPx", outputWidthPx],
    ["outputHeightPx", outputHeightPx]
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`Figure-export ${name} must be a positive integer.`);
    }
  }
  if (!Number.isFinite(pointSizePx) || pointSizePx <= 0) {
    throw new RangeError("Figure-export pointSizePx must be a finite positive number.");
  }
  if (typeof emphasizeSelection !== "boolean") {
    throw new TypeError("Figure-export emphasizeSelection must be a boolean.");
  }
  if (!Number.isFinite(selectionMutedOpacity) || selectionMutedOpacity < 0 || selectionMutedOpacity > 1) {
    throw new RangeError(
      "Figure-export selectionMutedOpacity must be between 0 and 1."
    );
  }
  if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 1) {
    throw new RangeError("Figure-export alphaThreshold must be between 0 and 1.");
  }
  const viewRect = assertNormalizedRect01(viewRect01, "Figure-export raster viewRect01");
  const packed = packBuffers({
    positions,
    dimension,
    colors,
    // The cells' colors: the alpha byte is their layer.
    colorAlpha: "layer",
    transparency,
    lodMembership,
    drawOrder,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity,
    alphaThreshold,
    pointLayers
  });
  const outW = outputWidthPx;
  const outH = outputHeightPx;
  const { canvas, gl } = acquireRasterContext(renderState.antialias);
  try {
    configureExactDrawingBuffer(gl, canvas, outW, outH);
  } catch (error) {
    shrinkRasterCanvas(canvas);
    throw error;
  }
  const { vs, fs, quality, depth } = pickShaderSources(
    renderState.shaderQuality,
    dimension
  );
  let program = null;
  let highlightProgram = null;
  const passes = [];
  let dummyAlphaTex = null;
  let dummyLodIndexTex = null;
  let rasterizationError = null;
  try {
    program = createProgram(gl, vs, fs);
    gl.useProgram(program);
    if (depth) {
      gl.enable(gl.DEPTH_TEST);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.depthFunc(gl.LEQUAL);
    configureStraightAlphaBlending(gl);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const srcViewportW = renderState.viewportWidth;
    const srcViewportH = renderState.viewportHeight;
    const s = Math.min(
      outW / (viewRect.width * srcViewportW),
      outH / (viewRect.height * srcViewportH)
    );
    const zoom = viewRectClipTransform(viewRect);
    const mvpMatrix = multiplyMat4(zoom, renderState.mvpMatrix);
    const projectionMatrix = multiplyMat4(zoom, renderState.projectionMatrix);
    gl.viewport(0, 0, outW, outH);
    const pointPass = uploadPointPass(gl, positionsForGpu(packed.positions, packed.dimension), packed.dimension, packed.colors, packed.count, "Figure-export point");
    passes.push(pointPass);
    const u = (name) => gl.getUniformLocation(program, name);
    const setMat4 = (loc, mat) => {
      if (loc) gl.uniformMatrix4fv(loc, false, mat);
    };
    const setF1 = (loc, v) => {
      if (loc) gl.uniform1f(loc, v);
    };
    const setI1 = (loc, v) => {
      if (loc) gl.uniform1i(loc, v);
    };
    const setV3 = (loc, v) => {
      if (loc && v) gl.uniform3fv(loc, v);
    };
    const fov = renderState.fov;
    const sizeAttenuation = renderState.sizeAttenuation;
    const pointSize = pointSizePx;
    const shaderFrame = {
      modelView: new Float32Array(16),
      halfDir: new Float32Array(3)
    };
    const pointScale = writePointShaderFrame(
      shaderFrame,
      renderState.viewMatrix,
      renderState.modelMatrix,
      renderState.lightDir,
      srcViewportH,
      fov
    );
    setMat4(u("u_mvpMatrix"), mvpMatrix);
    setMat4(u("u_modelViewMatrix"), shaderFrame.modelView);
    setMat4(u("u_projectionMatrix"), projectionMatrix);
    const pointSizeUniform = u("u_pointSize");
    setF1(pointSizeUniform, pointSize);
    const pointSizeMax = exportPointSizeMax(gl, renderState.pointSizeMax, s);
    setF1(u("u_pointSizeMax"), pointSizeMax);
    setF1(u("u_sizeAttenuation"), sizeAttenuation);
    setF1(u("u_pointScale"), pointScale);
    setI1(u("u_useAlphaTex"), 0);
    setI1(u("u_orderedSlots"), 0);
    dummyAlphaTex = gl.createTexture();
    if (!dummyAlphaTex) {
      throw new Error("Figure-export dummy alpha-texture allocation failed.");
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, dummyAlphaTex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    const alphaTexLoc = u("u_alphaTex");
    if (alphaTexLoc) gl.uniform1i(alphaTexLoc, 0);
    dummyLodIndexTex = gl.createTexture();
    if (!dummyLodIndexTex) {
      throw new Error("Figure-export dummy LOD-texture allocation failed.");
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, dummyLodIndexTex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R32UI, 1, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array([0]));
    const lodIndexTexLoc = u("u_lodIndexTex");
    if (lodIndexTexLoc) gl.uniform1i(lodIndexTexLoc, 1);
    const fogNear = renderState.fogNear;
    const fogFar = renderState.fogFar;
    const fogDensity = renderState.fogDensity;
    const lightingStrength = renderState.lightingStrength;
    const lightDir = renderState.lightDir;
    if (SHADER_QUALITY_TRAITS[quality].sphere) {
      setF1(u("u_lightingStrength"), lightingStrength);
      writeFogUniforms(gl, u("u_fogNear"), u("u_fogScale"), fogDensity, fogNear, fogFar);
      setV3(u("u_lightDir"), lightDir);
      setV3(u("u_halfDir"), shaderFrame.halfDir);
      setF1(u("u_invCenterShade"), shaderFrame.invCenterShade);
      setV3(u("u_fogColor"), renderState.fogColor);
    }
    const opaquePass = quality === "sculpted" && depth;
    if (opaquePass) {
      const multisampled = gl.getParameter(gl.SAMPLES) > 0;
      enterOpaquePointBlending(gl, multisampled);
      setF1(u("u_coverageFloor"), multisampled ? 0 : 0.5);
    }
    setI1(u("u_drawPass"), 0);
    const readPointSize = pointSize * (pointLayers === null ? 1 : pointLayers.readScale);
    if (packed.unread > 0) setF1(pointSizeUniform, readPointSize);
    drawPointPass(pointPass, packed.count, packed, {
      setYield: (value) => setI1(u("u_yieldDepth"), value),
      setUnread: (unread) => {
        setF1(pointSizeUniform, unread ? pointSize : readPointSize);
        if (SHADER_QUALITY_TRAITS[quality].sphere) setF1(u("u_lightingStrength"), unread ? 0 : lightingStrength);
        if (depth) gl.depthMask(!unread);
      }
    });
    if (overlayPoints !== null) {
      if (!overlayPoints || typeof overlayPoints !== "object") {
        throw new TypeError("Figure-export overlayPoints must be null or an object.");
      }
      const overlayCount = overlayPoints.positions?.length / 3;
      if (!(overlayPoints.positions instanceof Float32Array) || overlayPoints.positions.length === 0 || overlayPoints.positions.length % 3 !== 0 || !(overlayPoints.colors instanceof Uint8Array) || overlayPoints.colors.length !== overlayCount * 4) {
        throw new TypeError(
          "Figure-export overlayPoints require exact Float32 XYZ and Uint8 RGBA arrays."
        );
      }
      if (!Number.isFinite(overlayPoints.pointSizePx) || overlayPoints.pointSizePx <= 0) {
        throw new RangeError(
          "Figure-export overlayPoints.pointSizePx must be a finite positive number."
        );
      }
      const overlayLodMembership = overlayPoints.lodMembership ?? null;
      assertLodMembership(overlayLodMembership, { pointCount: overlayCount });
      const overlayPacked = packBuffers({
        positions: overlayPoints.positions,
        dimension: 3,
        colors: overlayPoints.colors,
        // A centroid's alpha byte is its opacity (0: its category is hidden).
        colorAlpha: "opacity",
        transparency: overlayPoints.transparency ?? null,
        lodMembership: overlayLodMembership,
        highlightArray: null,
        emphasizeSelection: false,
        selectionMutedOpacity: 1,
        alphaThreshold: overlayPoints.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD
      });
      if (overlayPacked.count > 0) {
        const overlayPass = uploadPointPass(gl, overlayPacked.positions, 3, overlayPacked.colors, overlayPacked.count, "Figure-export overlay");
        passes.push(overlayPass);
        setF1(u("u_pointSize"), overlayPoints.pointSizePx);
        setF1(u("u_pointSizeMax"), pointSizeMax);
        drawPointPass(overlayPass, overlayPacked.count);
      }
    }
    if (opaquePass) {
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      configureStraightAlphaBlending(gl);
    }
    const highlightOverlay = buildHighlightOverlayBuffers({
      positions,
      dimension,
      highlightArray,
      transparency,
      lodMembership,
      drawOrder,
      alphaThreshold
    });
    if (highlightOverlay?.count) {
      highlightProgram = createProgram(gl, HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT);
      gl.useProgram(highlightProgram);
      const highlightPass = uploadPointPass(
        gl,
        highlightOverlay.positions,
        highlightOverlay.dimension,
        highlightOverlay.colors,
        highlightOverlay.count,
        "Figure-export highlight"
      );
      passes.push(highlightPass);
      const hu = (name) => gl.getUniformLocation(highlightProgram, name);
      const setHMat4 = (loc, mat) => {
        if (loc) gl.uniformMatrix4fv(loc, false, mat);
      };
      const setHF1 = (loc, v) => {
        if (loc) gl.uniform1f(loc, v);
      };
      const setHV3 = (loc, v) => {
        if (loc && v) gl.uniform3fv(loc, v);
      };
      setHMat4(hu("u_modelViewMatrix"), shaderFrame.modelView);
      setHMat4(hu("u_projectionMatrix"), projectionMatrix);
      setHF1(hu("u_pointSize"), pointSize);
      setHF1(hu("u_pointSizeMax"), pointSizeMax);
      setHF1(hu("u_sizeAttenuation"), sizeAttenuation);
      setHF1(hu("u_pointScale"), pointScale);
      const style = HIGHLIGHT_STYLES_BY_QUALITY[quality];
      setHF1(hu("u_gpuPointSizeMax"), gpuPointSizeMax(gl) ?? pointSizeMax * style.scale);
      setHF1(hu("u_highlightScale"), style.scale);
      setHV3(hu("u_highlightColor"), HIGHLIGHT_COLOR);
      setHV3(hu("u_highlightRingColor"), HIGHLIGHT_RING_COLOR);
      setHF1(hu("u_ringWidth"), style.ringWidth);
      setHF1(hu("u_haloStrength"), style.haloStrength);
      setHF1(hu("u_haloShape"), style.haloShape);
      setHF1(hu("u_ringStyle"), style.ringStyle);
      setHF1(hu("u_time"), 0);
      setHF1(hu("u_glow"), highlightGlowAt(0));
      writeFogUniforms(gl, hu("u_fogNear"), hu("u_fogScale"), fogDensity, fogNear, fogFar);
      setHF1(hu("u_lightingStrength"), lightingStrength);
      setHV3(hu("u_lightDir"), lightDir);
      setHV3(hu("u_halfDir"), shaderFrame.halfDir);
      gl.enable(gl.DEPTH_TEST);
      configureStraightAlphaBlending(gl);
      try {
        gl.depthMask(false);
        drawPointPass(highlightPass, highlightOverlay.count);
      } finally {
        gl.depthMask(true);
      }
    }
    gl.flush();
  } catch (error) {
    rasterizationError = new Error(
      `Figure-export WebGL2 point rasterization failed: ${error.message}`,
      { cause: error }
    );
  }
  const cleanupErrors = [];
  const cleanup = (operation, fn) => {
    try {
      fn();
    } catch (error) {
      cleanupErrors.push(new Error(
        `Figure-export WebGL2 cleanup failed during ${operation}: ${error.message}`,
        { cause: error }
      ));
    }
  };
  cleanup("array-buffer unbind", () => gl.bindBuffer(gl.ARRAY_BUFFER, null));
  cleanup("vertex-array unbind", () => gl.bindVertexArray(null));
  for (const pass of passes) cleanup("point vertex-array deletion", () => pass.arrays.delete());
  for (const pass of passes) {
    cleanup("position-buffer deletion", () => pass.positions.delete());
    cleanup("color-buffer deletion", () => pass.colors.delete());
  }
  if (dummyAlphaTex) cleanup("alpha-texture deletion", () => deleteTextureTracked(gl, dummyAlphaTex));
  if (dummyLodIndexTex) cleanup("LOD-index-texture deletion", () => deleteTextureTracked(gl, dummyLodIndexTex));
  if (highlightProgram) cleanup("highlight-program deletion", () => deleteProgramReleasingUse(gl, highlightProgram));
  if (program) cleanup("point-program deletion", () => deleteProgramReleasingUse(gl, program));
  const failures = [
    ...rasterizationError ? [rasterizationError] : [],
    ...cleanupErrors
  ];
  let frame = null;
  if (failures.length === 0) {
    try {
      frame = canvas.transferToImageBitmap();
    } catch (error) {
      failures.push(new Error(
        `Figure-export WebGL2 frame transfer failed: ${error.message}`,
        { cause: error }
      ));
    }
  }
  shrinkRasterCanvas(canvas);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Figure-export WebGL2 rasterization and cleanup failed."
    );
  }
  return frame;
}

// assets/js/formats/io/byte-order.js
var HOST_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

// assets/js/formats/zip/crc32.js
var TABLES = (() => {
  const tables = new Uint32Array(16 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 16; t++) {
      c = tables[c & 255] ^ c >>> 8;
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();
function step16(t, a, b, c, d) {
  return t[3840 + (a & 255)] ^ t[3584 + (a >>> 8 & 255)] ^ t[3328 + (a >>> 16 & 255)] ^ t[3072 + (a >>> 24)] ^ t[2816 + (b & 255)] ^ t[2560 + (b >>> 8 & 255)] ^ t[2304 + (b >>> 16 & 255)] ^ t[2048 + (b >>> 24)] ^ t[1792 + (c & 255)] ^ t[1536 + (c >>> 8 & 255)] ^ t[1280 + (c >>> 16 & 255)] ^ t[1024 + (c >>> 24)] ^ t[768 + (d & 255)] ^ t[512 + (d >>> 8 & 255)] ^ t[256 + (d >>> 16 & 255)] ^ t[d >>> 24];
}
function crc32(bytes, previous = 0) {
  const t = TABLES;
  let crc = ~previous >>> 0;
  let i = 0;
  const length = bytes.length;
  if (HOST_LITTLE_ENDIAN) {
    while (i < length && (bytes.byteOffset + i & 3) !== 0) crc = t[(crc ^ bytes[i++]) & 255] ^ crc >>> 8;
    const fast = length - i >>> 4 << 2;
    if (fast > 0) {
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset + i, fast);
      for (let w = 0; w < fast; w += 4) crc = step16(t, words[w] ^ crc, words[w + 1], words[w + 2], words[w + 3]);
      i += fast * 4;
    }
  } else {
    const word = (at) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24;
    const fast = length - length % 16;
    for (; i < fast; i += 16) crc = step16(t, word(i) ^ crc, word(i + 4), word(i + 8), word(i + 12));
  }
  for (; i < length; i++) crc = t[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
  return ~crc >>> 0;
}

// assets/js/app/ui/modules/figure-export/utils/png-metadata.js
var PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function isPng(bytes) {
  if (!bytes || bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
function readU32BE(bytes, offset) {
  return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
function writeU32BE(bytes, offset, value) {
  bytes[offset] = value >>> 24 & 255;
  bytes[offset + 1] = value >>> 16 & 255;
  bytes[offset + 2] = value >>> 8 & 255;
  bytes[offset + 3] = value & 255;
}
function asciiBytes(value, context) {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value)) {
    throw new TypeError(`${context} must be a non-empty printable ASCII string.`);
  }
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
  return out;
}
function makeChunk(type, data) {
  const typeBytes = asciiBytes(type, "PNG chunk type");
  const length = data.length >>> 0;
  const out = new Uint8Array(4 + 4 + length + 4);
  writeU32BE(out, 0, length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + length));
  writeU32BE(out, 8 + length, crc);
  return out;
}
function makeTextChunk(keyword, text) {
  if (typeof keyword !== "string" || keyword.length < 1 || keyword.length > 79) {
    throw new TypeError("PNG metadata keyword must contain 1 through 79 characters.");
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("PNG metadata text must be a non-empty string.");
  }
  const keyBytes = asciiBytes(keyword, "PNG metadata keyword");
  const textBytes = new TextEncoder().encode(text);
  const data = new Uint8Array(keyBytes.length + 5 + textBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0;
  data[keyBytes.length + 1] = 0;
  data[keyBytes.length + 2] = 0;
  data[keyBytes.length + 3] = 0;
  data[keyBytes.length + 4] = 0;
  data.set(textBytes, keyBytes.length + 5);
  return makeChunk("iTXt", data);
}
var METRES_PER_INCH = 0.0254;
function makeResolutionChunk(dpi) {
  const perMetre = Math.round(dpi / METRES_PER_INCH);
  const data = new Uint8Array(9);
  writeU32BE(data, 0, perMetre);
  writeU32BE(data, 4, perMetre);
  data[8] = 1;
  return makeChunk("pHYs", data);
}
async function embedPngMetadata(blob, { text, dpi }) {
  if (!(blob instanceof Blob) || blob.type !== "image/png") {
    throw new TypeError("PNG metadata input must be an image/png Blob.");
  }
  if (text === null || typeof text !== "object" || Array.isArray(text) || Object.getPrototypeOf(text) !== Object.prototype) {
    throw new TypeError("PNG metadata must be a plain object.");
  }
  const entries = Object.entries(text);
  if (entries.length === 0) {
    throw new TypeError("PNG metadata must contain at least one entry.");
  }
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError("PNG metadata needs the resolution in dots per inch.");
  }
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!isPng(bytes)) {
    throw new Error("PNG metadata input has an invalid PNG signature.");
  }
  const kept = [];
  let offset = 8;
  let headerEnd = -1;
  let iendOffset = -1;
  while (offset + 8 <= bytes.length) {
    const len = readU32BE(bytes, offset);
    if (len > bytes.length - offset - 12) {
      throw new Error("PNG metadata input contains a truncated chunk.");
    }
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const chunkSize = 12 + len;
    const expectedCrc = readU32BE(bytes, offset + 8 + len);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + len));
    if (expectedCrc !== actualCrc) {
      throw new Error(`PNG metadata input contains an invalid ${type} chunk CRC.`);
    }
    if (offset === 8) {
      if (type !== "IHDR") throw new Error("PNG metadata input does not start with IHDR.");
      headerEnd = offset + chunkSize;
    } else if (type === "IEND") {
      if (len !== 0 || offset + chunkSize !== bytes.length) {
        throw new Error("PNG metadata input contains an invalid IEND chunk.");
      }
      iendOffset = offset;
      break;
    } else if (type !== "pHYs") {
      kept.push(bytes.subarray(offset, offset + chunkSize));
    }
    offset += chunkSize;
  }
  if (iendOffset < 0) {
    throw new Error("PNG metadata input has no IEND chunk.");
  }
  return new Blob(
    [
      bytes.subarray(0, headerEnd),
      makeResolutionChunk(dpi),
      ...kept,
      ...entries.map(([keyword, value]) => makeTextChunk(keyword, value)),
      bytes.subarray(iendOffset)
    ],
    { type: "image/png" }
  );
}

// assets/js/app/utils/number-utils.js
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// assets/js/app/ui/modules/figure-export/utils/point-size.js
function paneFrame(renderState) {
  const frame = { modelView: new Float32Array(16), halfDir: new Float32Array(3), invCenterShade: 1 };
  const pointScale = writePointShaderFrame(
    frame,
    renderState.viewMatrix,
    renderState.modelMatrix,
    renderState.lightDir,
    renderState.viewportHeight,
    renderState.fov
  );
  return { modelView: frame.modelView, pointScale };
}
function createViewportPointDiameter(renderState) {
  const attenuation = renderState?.sizeAttenuation;
  if (!isFiniteNumber(attenuation) || attenuation < 0 || attenuation > 1) {
    throw new RangeError("Figure-export size attenuation must be a number from 0 to 1.");
  }
  if (!isFiniteNumber(renderState.pointSizeMax) || renderState.pointSizeMax <= 0) {
    throw new RangeError("Figure-export point size cap must be a finite positive number.");
  }
  const { modelView: mv, pointScale } = paneFrame(renderState);
  const sprite = { pointSize: 0, pointScale, sizeAttenuation: attenuation, pointSizeMax: renderState.pointSizeMax };
  return (x, y, z, pointSize) => {
    sprite.pointSize = pointSize;
    return pointSpriteSize(-(mv[2] * x + mv[6] * y + mv[10] * z + mv[14]), sprite);
  };
}

// assets/js/app/ui/modules/figure-export/utils/point-projector.js
function forEachProjectedPoint({
  positions,
  dimension,
  colors,
  colorAlpha,
  transparency = null,
  renderState,
  plotRect,
  pointDiameterViewportPx,
  lodMembership = null,
  drawOrder = null,
  crop = null,
  sortByDepth = false,
  depthBins = 256,
  pointLayers = null,
  onPoint
}) {
  const alphaIsOpacity = requireColorAlphaMeaning(colorAlpha, "Figure-export projected colors") === "opacity";
  const layers = alphaIsOpacity ? null : requireFigurePointLayers(pointLayers, "Figure-export projected point layers");
  const unreadRgb = layers === null ? null : layers.unreadColor.map((channel) => Math.round(channel * 255));
  const zeroRgb = layers === null ? null : layers.zeroColor.map((channel) => Math.round(channel * 255));
  if (!(typeof pointDiameterViewportPx === "number" && Number.isFinite(pointDiameterViewportPx) && pointDiameterViewportPx > 0)) {
    throw new RangeError("Figure-export point diameter must be a finite positive number.");
  }
  const readDiameter = pointDiameterViewportPx * (layers === null ? 1 : layers.readScale);
  const isUnread = (i) => layers !== null && colors[i * 4 + 3] === UNREAD_ALPHA_BYTE;
  const isZero = (i) => zeroRgb !== null && colors[i * 4 + 3] === BENEATH_ALPHA_BYTE;
  if (!positions || !colors || !renderState?.mvpMatrix) {
    return { drawn: 0, skipped: 0 };
  }
  const opacityOf = (i) => transparency ? transparency[i] ?? 1 : alphaIsOpacity ? colors[i * 4 + 3] / 255 : 1;
  const positionCount = requirePositionArray(
    positions,
    dimension,
    "Figure-export projected positions",
    { allowEmpty: true }
  );
  const n = Math.min(positionCount, Math.floor(colors.length / 4));
  assertLodMembership(lodMembership, {
    pointCount: positionCount
  });
  assertDrawOrder(drawOrder, { pointCount: positionCount });
  const admittedIndices = drawnSequence(lodMembership, drawOrder, alphaIsOpacity ? null : colors, layers?.readEveryLevel === true);
  const candidateCount = admittedIndices?.length ?? n;
  const mvp = renderState.mvpMatrix;
  const { source, viewportToPlot } = createPlotPlacement({ renderState, plotRect, crop });
  const origin = viewportToPlot(source.x, source.y);
  const plotX0 = origin.x;
  const plotY0 = origin.y;
  const scaleX = plotRect.width / source.width;
  const scaleY = plotRect.height / source.height;
  const local = new Float64Array(3);
  const diameterAt = createViewportPointDiameter(renderState);
  const radiusAt = (x, y, z, pointSize) => diameterAt(x, y, z, pointSize) * scaleX * 0.5;
  let drawn = 0;
  let skipped = n - candidateCount;
  const projected = [0, 0];
  const at = [0, 0, 0];
  const project = (i) => {
    const rawAlpha = opacityOf(i);
    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1;
    if (alpha < 0) alpha = 0;
    else if (alpha > 1) alpha = 1;
    if (alpha < POINT_VISIBILITY_THRESHOLD) return 0;
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (!projectIntoSource(mvp, source, x, y, z, local)) return 0;
    projected[0] = plotX0 + local[0] * scaleX;
    projected[1] = plotY0 + local[1] * scaleY;
    at[0] = x;
    at[1] = y;
    at[2] = z;
    return alpha;
  };
  if (sortByDepth) {
    let unreadDrawn = 0;
    if (layers !== null) {
      for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
        const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
        if (!isUnread(i)) break;
        const alpha = project(i);
        if (alpha === 0) continue;
        onPoint(projected[0], projected[1], unreadRgb[0], unreadRgb[1], unreadRgb[2], alpha, radiusAt(at[0], at[1], at[2], pointDiameterViewportPx), i);
        unreadDrawn++;
      }
    }
    let bins = depthBins | 0;
    if (bins < 16) bins = 16;
    else if (bins > 1024) bins = 1024;
    const counts = new Uint32Array(bins);
    let total = 0;
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
      const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
      if (isUnread(i)) continue;
      const rawAlpha = opacityOf(i);
      let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1;
      if (alpha < 0) alpha = 0;
      else if (alpha > 1) alpha = 1;
      if (alpha < POINT_VISIBILITY_THRESHOLD) continue;
      const ix = i * dimension;
      const x = positions[ix];
      const y = dimension > 1 ? positions[ix + 1] : 0;
      const z = dimension > 2 ? positions[ix + 2] : 0;
      if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
      const ndcZ = local[2];
      let bin = (ndcZ + 1) * 0.5 * bins | 0;
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      counts[bin]++;
      total++;
    }
    if (total === 0) return { drawn: unreadDrawn, skipped: n - unreadDrawn };
    const offsets = new Uint32Array(bins);
    let cursor = 0;
    for (let b = 0; b < bins; b++) {
      offsets[b] = cursor;
      cursor += counts[b];
      counts[b] = 0;
    }
    const outX = new Float32Array(total);
    const outY = new Float32Array(total);
    const outRGBA = new Uint8Array(total * 4);
    const outA = new Float32Array(total);
    const outRadius = new Float32Array(total);
    const outIndex = new Uint32Array(total);
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
      const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
      if (isUnread(i)) continue;
      const rawAlpha = opacityOf(i);
      let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1;
      if (alpha < 0) alpha = 0;
      else if (alpha > 1) alpha = 1;
      if (alpha < POINT_VISIBILITY_THRESHOLD) continue;
      const ix = i * dimension;
      const x = positions[ix];
      const y = dimension > 1 ? positions[ix + 1] : 0;
      const z = dimension > 2 ? positions[ix + 2] : 0;
      if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
      const ndcZ = local[2];
      let bin = (ndcZ + 1) * 0.5 * bins | 0;
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      const slot = offsets[bin] + counts[bin]++;
      outX[slot] = plotX0 + local[0] * scaleX;
      outY[slot] = plotY0 + local[1] * scaleY;
      const cj = i * 4;
      const oj = slot * 4;
      const zero = isZero(i);
      outRGBA[oj] = zero ? zeroRgb[0] : colors[cj];
      outRGBA[oj + 1] = zero ? zeroRgb[1] : colors[cj + 1];
      outRGBA[oj + 2] = zero ? zeroRgb[2] : colors[cj + 2];
      outRGBA[oj + 3] = colors[cj + 3];
      outA[slot] = alpha;
      outRadius[slot] = radiusAt(x, y, z, readDiameter);
      outIndex[slot] = i;
    }
    for (let b = bins - 1; b >= 0; b--) {
      const start = offsets[b];
      const end = start + counts[b];
      for (let s = start; s < end; s++) {
        const a = outA[s];
        if (a < POINT_VISIBILITY_THRESHOLD) continue;
        const oj = s * 4;
        onPoint(outX[s], outY[s], outRGBA[oj], outRGBA[oj + 1], outRGBA[oj + 2], a, outRadius[s], outIndex[s]);
        drawn++;
      }
    }
    drawn += unreadDrawn;
    skipped = Math.max(0, n - drawn);
    return { drawn, skipped };
  }
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
    const rawAlpha = opacityOf(i);
    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1;
    if (alpha < 0) alpha = 0;
    else if (alpha > 1) alpha = 1;
    if (alpha < POINT_VISIBILITY_THRESHOLD) {
      skipped++;
      continue;
    }
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (!projectIntoSource(mvp, source, x, y, z, local)) {
      skipped++;
      continue;
    }
    const px = plotX0 + local[0] * scaleX;
    const py = plotY0 + local[1] * scaleY;
    const j = i * 4;
    if (isUnread(i)) onPoint(px, py, unreadRgb[0], unreadRgb[1], unreadRgb[2], alpha, radiusAt(x, y, z, pointDiameterViewportPx), i);
    else if (isZero(i)) onPoint(px, py, zeroRgb[0], zeroRgb[1], zeroRgb[2], alpha, radiusAt(x, y, z, readDiameter), i);
    else onPoint(px, py, colors[j], colors[j + 1], colors[j + 2], alpha, radiusAt(x, y, z, readDiameter), i);
    drawn++;
  }
  return { drawn, skipped };
}

// assets/js/app/utils/random-utils.js
function createMulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 1831565813;
    let x = Math.imul(t ^ t >>> 15, t | 1);
    x ^= x + Math.imul(x ^ x >>> 7, x | 61);
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

// assets/js/app/ui/modules/figure-export/utils/density-reducer.js
function clampInt(value, lo, hi) {
  return clamp(value | 0, lo, hi);
}
function createEmptyReducedViewportPoints(viewportWidth, viewportHeight, scannedSourceCount = 0, candidateSourceCount = 0) {
  return {
    x: new Float32Array(0),
    y: new Float32Array(0),
    rgba: new Uint8Array(0),
    alpha: new Float32Array(0),
    index: new Uint32Array(0),
    highlighted: new Uint8Array(0),
    scannedSourceCount,
    candidateSourceCount,
    viewportWidth,
    viewportHeight
  };
}
function apportionDensitySlots(populations, populationTotal, targetTotal) {
  const cellCount = populations.length;
  const desired = new Uint32Array(cellCount);
  if (targetTotal === 0) return desired;
  if (!Number.isSafeInteger(populationTotal) || !Number.isSafeInteger(targetTotal) || populationTotal < 0 || targetTotal < 0 || targetTotal > populationTotal) {
    throw new RangeError(
      "Figure-export density allocation requires an exact target within its population."
    );
  }
  const remainders = new Float64Array(cellCount);
  const remainderCells = [];
  let nonEmptyCells = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    if (populations[cell] > 0) nonEmptyCells++;
  }
  const reserveOnePerCell = targetTotal >= nonEmptyCells;
  const reservedTotal = reserveOnePerCell ? nonEmptyCells : 0;
  const remainingTarget = targetTotal - reservedTotal;
  const remainingPopulation = populationTotal - reservedTotal;
  let desiredSum = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    const population = populations[cell];
    if (!population) continue;
    const reserved = reserveOnePerCell ? 1 : 0;
    const weight = population - reserved;
    const exactExtra = remainingTarget > 0 && remainingPopulation > 0 ? weight / remainingPopulation * remainingTarget : 0;
    const extra = Math.floor(exactExtra);
    const keep = reserved + extra;
    desired[cell] = keep;
    desiredSum += keep;
    if (keep < population) {
      remainders[cell] = exactExtra - extra;
      remainderCells.push(cell);
    }
  }
  let unallocated = targetTotal - desiredSum;
  if (unallocated > 0) {
    remainderCells.sort((cellA, cellB) => {
      const remainderDifference = remainders[cellB] - remainders[cellA];
      return remainderDifference || cellA - cellB;
    });
    for (let remainderIndex = 0; remainderIndex < remainderCells.length && unallocated > 0; remainderIndex++) {
      desired[remainderCells[remainderIndex]]++;
      unallocated--;
    }
  }
  if (unallocated !== 0) {
    throw new Error(
      "Figure-export density allocation could not satisfy the exact target."
    );
  }
  return desired;
}
function reducePointsByDensity({
  positions,
  dimension,
  colors,
  transparency = null,
  lodMembership = null,
  highlightArray = null,
  highlightedIndices = null,
  renderState,
  targetCount,
  crop = null,
  gridSize = 160,
  maxScanPoints = null,
  seed = 1337
}) {
  if (!positions || !colors || !renderState?.mvpMatrix) {
    return createEmptyReducedViewportPoints(
      renderState?.viewportWidth || 1,
      renderState?.viewportHeight || 1
    );
  }
  const sourcePointCount = requirePositionArray(
    positions,
    dimension,
    "Figure-export density positions",
    { allowEmpty: true }
  );
  const n = Math.min(sourcePointCount, Math.floor(colors.length / 4));
  const requestedTotal = Number.isFinite(targetCount) ? Math.max(0, Math.floor(targetCount)) : 0;
  if (maxScanPoints !== null && (!Number.isSafeInteger(maxScanPoints) || maxScanPoints < 1)) {
    throw new RangeError(
      "Figure-export density maxScanPoints must be null or a positive safe integer."
    );
  }
  requireLodMembership(lodMembership, {
    pointCount: sourcePointCount,
    owner: "Figure-export density LOD membership"
  });
  if (highlightArray !== null && (!(highlightArray instanceof Uint8Array) || highlightArray.length !== sourcePointCount)) {
    throw new TypeError(
      "Figure-export density highlightArray must be null or one exact Uint8 value per source point."
    );
  }
  if (highlightedIndices !== null && (highlightArray === null || !Array.isArray(highlightedIndices) && !(highlightedIndices instanceof Uint32Array))) {
    throw new TypeError(
      "Figure-export density highlightedIndices require highlightArray and must be an Array or Uint32Array."
    );
  }
  let sparseHighlightIds = null;
  if (highlightedIndices !== null && highlightedIndices.length <= requestedTotal) {
    sparseHighlightIds = /* @__PURE__ */ new Set();
    for (const pointIndex of highlightedIndices) {
      if (!Number.isSafeInteger(pointIndex) || pointIndex < 0 || pointIndex >= sourcePointCount || sparseHighlightIds.has(pointIndex) || highlightArray[pointIndex] < MIN_VISIBLE_ALPHA_BYTE) {
        throw new RangeError(
          "Figure-export density highlightedIndices must be unique visible highlight IDs in the current source generation."
        );
      }
      sparseHighlightIds.add(pointIndex);
    }
  }
  const admittedIndices = lodMembership?.indices ?? null;
  const candidateCount = lodMembership === null ? n : Math.min(n, lodMembership.count);
  const primaryScanCount = maxScanPoints === null ? candidateCount : Math.min(candidateCount, maxScanPoints);
  const scanBaseStep = primaryScanCount === 0 ? 0 : Math.floor(candidateCount / primaryScanCount);
  const scanRemainderStep = primaryScanCount === 0 ? 0 : candidateCount % primaryScanCount;
  const mvp = renderState.mvpMatrix;
  const source = figureSourceRect({ renderState, crop });
  const effW = source.width;
  const effH = source.height;
  const local = new Float64Array(3);
  if (requestedTotal === 0) {
    return createEmptyReducedViewportPoints(
      effW,
      effH,
      0,
      candidateCount
    );
  }
  const cols = clampInt(gridSize, 32, 512);
  const rows = clampInt(gridSize, 32, 512);
  const cellCount = cols * rows;
  const counts = new Uint32Array(cellCount);
  const highlightCounts = highlightArray === null ? null : new Uint32Array(cellCount);
  const stridedHighlightIds = sparseHighlightIds !== null && primaryScanCount < candidateCount ? /* @__PURE__ */ new Set() : null;
  let visibleTotal = 0;
  let visibleHighlightTotal = 0;
  let supplementalScanCount = 0;
  let candidateIndex = 0;
  let scanRemainder = 0;
  for (let sampleIndex = 0; sampleIndex < primaryScanCount; sampleIndex++) {
    const sampledCandidateIndex = candidateIndex;
    candidateIndex += scanBaseStep;
    scanRemainder += scanRemainderStep;
    if (scanRemainder >= primaryScanCount) {
      candidateIndex++;
      scanRemainder -= primaryScanCount;
    }
    const i = admittedIndices === null ? sampledCandidateIndex : admittedIndices[sampledCandidateIndex];
    if (i >= n) continue;
    const isHighlighted = highlightArray !== null && highlightArray[i] >= MIN_VISIBLE_ALPHA_BYTE;
    if (isHighlighted && stridedHighlightIds !== null) {
      stridedHighlightIds.add(i);
    }
    const rawAlpha = transparency ? transparency[i] ?? 1 : 1;
    let a = Number.isFinite(rawAlpha) ? rawAlpha : 1;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (a < POINT_VISIBILITY_THRESHOLD) continue;
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
    const vx = local[0];
    const vy = local[1];
    const cx = clampInt(vx / effW * cols, 0, cols - 1);
    const cy = clampInt(vy / effH * rows, 0, rows - 1);
    const cell = cy * cols + cx;
    counts[cell]++;
    if (isHighlighted) {
      highlightCounts[cell]++;
      visibleHighlightTotal++;
    }
    visibleTotal++;
  }
  if (stridedHighlightIds !== null) {
    for (const i of sparseHighlightIds) {
      if (stridedHighlightIds.has(i)) continue;
      supplementalScanCount++;
      if (i >= n || !lodMembershipAdmits(lodMembership, i)) {
        continue;
      }
      const rawAlpha = transparency ? transparency[i] ?? 1 : 1;
      let a = Number.isFinite(rawAlpha) ? rawAlpha : 1;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      if (a < POINT_VISIBILITY_THRESHOLD) continue;
      const ix = i * dimension;
      const x = positions[ix];
      const y = dimension > 1 ? positions[ix + 1] : 0;
      const z = dimension > 2 ? positions[ix + 2] : 0;
      if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
      const vx = local[0];
      const vy = local[1];
      const cx = clampInt(vx / effW * cols, 0, cols - 1);
      const cy = clampInt(vy / effH * rows, 0, rows - 1);
      const cell = cy * cols + cx;
      counts[cell]++;
      highlightCounts[cell]++;
      visibleTotal++;
      visibleHighlightTotal++;
    }
  }
  if (visibleTotal <= 0) {
    return createEmptyReducedViewportPoints(
      effW,
      effH,
      primaryScanCount + supplementalScanCount,
      candidateCount
    );
  }
  const desiredTotal = Math.min(requestedTotal, visibleTotal);
  if (desiredTotal === 0) {
    return createEmptyReducedViewportPoints(
      effW,
      effH,
      primaryScanCount + supplementalScanCount,
      candidateCount
    );
  }
  let highlightDesired = new Uint32Array(cellCount);
  let regularDesired;
  if (highlightCounts !== null && visibleHighlightTotal > 0) {
    if (visibleHighlightTotal <= desiredTotal) {
      highlightDesired = highlightCounts;
      const regularCounts = new Uint32Array(cellCount);
      for (let cell = 0; cell < cellCount; cell++) {
        regularCounts[cell] = counts[cell] - highlightCounts[cell];
      }
      regularDesired = apportionDensitySlots(
        regularCounts,
        visibleTotal - visibleHighlightTotal,
        desiredTotal - visibleHighlightTotal
      );
    } else {
      highlightDesired = apportionDensitySlots(
        highlightCounts,
        visibleHighlightTotal,
        desiredTotal
      );
      regularDesired = new Uint32Array(cellCount);
    }
  } else {
    regularDesired = apportionDensitySlots(
      counts,
      visibleTotal,
      desiredTotal
    );
  }
  const offsets = new Uint32Array(cellCount);
  let cursor = 0;
  for (let c = 0; c < cellCount; c++) {
    offsets[c] = cursor;
    cursor += highlightDesired[c] + regularDesired[c];
  }
  const outCount = cursor;
  if (outCount !== desiredTotal) {
    throw new Error(
      "Figure-export density quotas do not match the exact output target."
    );
  }
  const outX = new Float32Array(outCount);
  const outY = new Float32Array(outCount);
  const outRGBA = new Uint8Array(outCount * 4);
  const outA = new Float32Array(outCount);
  const outIndex = new Uint32Array(outCount);
  const outHighlighted = new Uint8Array(outCount);
  const seenHighlights = new Uint32Array(cellCount);
  const seenRegular = new Uint32Array(cellCount);
  const rnd = createMulberry32(seed);
  candidateIndex = 0;
  scanRemainder = 0;
  for (let sampleIndex = 0; sampleIndex < primaryScanCount; sampleIndex++) {
    const sampledCandidateIndex = candidateIndex;
    candidateIndex += scanBaseStep;
    scanRemainder += scanRemainderStep;
    if (scanRemainder >= primaryScanCount) {
      candidateIndex++;
      scanRemainder -= primaryScanCount;
    }
    const i = admittedIndices === null ? sampledCandidateIndex : admittedIndices[sampledCandidateIndex];
    if (i >= n) continue;
    const isHighlighted = highlightArray !== null && highlightArray[i] >= MIN_VISIBLE_ALPHA_BYTE;
    const rawAlpha = transparency ? transparency[i] ?? 1 : 1;
    let a = Number.isFinite(rawAlpha) ? rawAlpha : 1;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (a < POINT_VISIBILITY_THRESHOLD) continue;
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
    const vx = local[0];
    const vy = local[1];
    const cx = clampInt(vx / effW * cols, 0, cols - 1);
    const cy = clampInt(vy / effH * rows, 0, rows - 1);
    const cell = cy * cols + cx;
    const desired = isHighlighted ? highlightDesired : regularDesired;
    const seen = isHighlighted ? seenHighlights : seenRegular;
    const want = desired[cell];
    if (!want) continue;
    const k = ++seen[cell];
    let slot;
    if (k <= want) {
      slot = offsets[cell] + (isHighlighted ? 0 : highlightDesired[cell]) + (k - 1);
    } else {
      const j = Math.floor(rnd() * k);
      if (j >= want) continue;
      slot = offsets[cell] + (isHighlighted ? 0 : highlightDesired[cell]) + j;
    }
    outX[slot] = vx;
    outY[slot] = vy;
    const cj = i * 4;
    const oj = slot * 4;
    outRGBA[oj] = colors[cj];
    outRGBA[oj + 1] = colors[cj + 1];
    outRGBA[oj + 2] = colors[cj + 2];
    outRGBA[oj + 3] = 255;
    outA[slot] = a;
    outIndex[slot] = i;
    outHighlighted[slot] = isHighlighted ? highlightArray[i] : 0;
  }
  if (stridedHighlightIds !== null) {
    for (const i of sparseHighlightIds) {
      if (stridedHighlightIds.has(i) || i >= n || !lodMembershipAdmits(lodMembership, i)) {
        continue;
      }
      const rawAlpha = transparency ? transparency[i] ?? 1 : 1;
      let a = Number.isFinite(rawAlpha) ? rawAlpha : 1;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      if (a < POINT_VISIBILITY_THRESHOLD) continue;
      const ix = i * dimension;
      const x = positions[ix];
      const y = dimension > 1 ? positions[ix + 1] : 0;
      const z = dimension > 2 ? positions[ix + 2] : 0;
      if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
      const vx = local[0];
      const vy = local[1];
      const cx = clampInt(vx / effW * cols, 0, cols - 1);
      const cy = clampInt(vy / effH * rows, 0, rows - 1);
      const cell = cy * cols + cx;
      const want = highlightDesired[cell];
      if (!want) continue;
      const k = ++seenHighlights[cell];
      let slot;
      if (k <= want) {
        slot = offsets[cell] + (k - 1);
      } else {
        const replacementIndex = Math.floor(rnd() * k);
        if (replacementIndex >= want) continue;
        slot = offsets[cell] + replacementIndex;
      }
      outX[slot] = vx;
      outY[slot] = vy;
      const colorIndex = i * 4;
      const outputColorIndex = slot * 4;
      outRGBA[outputColorIndex] = colors[colorIndex];
      outRGBA[outputColorIndex + 1] = colors[colorIndex + 1];
      outRGBA[outputColorIndex + 2] = colors[colorIndex + 2];
      outRGBA[outputColorIndex + 3] = 255;
      outA[slot] = a;
      outIndex[slot] = i;
      outHighlighted[slot] = highlightArray[i];
    }
  }
  return {
    x: outX,
    y: outY,
    rgba: outRGBA,
    alpha: outA,
    index: outIndex,
    highlighted: outHighlighted,
    scannedSourceCount: primaryScanCount + supplementalScanCount,
    candidateSourceCount: candidateCount,
    viewportWidth: effW,
    viewportHeight: effH
  };
}

// assets/js/app/ui/modules/figure-export/utils/highlight-legend.js
var HIGHLIGHT_RGB = Object.freeze(HIGHLIGHT_COLOR.map((channel) => Math.round(channel * 255)));
var HIGHLIGHT_CSS = `rgb(${HIGHLIGHT_RGB.join(", ")})`;

// assets/js/app/ui/modules/figure-export/utils/fog.js
function createFogEvaluator(renderState) {
  if (renderState === null || typeof renderState !== "object") return null;
  const traits = SHADER_QUALITY_TRAITS[renderState.shaderQuality];
  if (traits === void 0 || traits.fog !== true) return null;
  const fogDensity = renderState.fogDensity;
  const fogNear = renderState.fogNear;
  const fogFar = renderState.fogFar;
  const fogColor = renderState.fogColor;
  const view = renderState.viewMatrix;
  const model = renderState.modelMatrix;
  if (!Number.isFinite(fogDensity) || !Number.isFinite(fogNear) || !Number.isFinite(fogFar) || !(fogColor?.length >= 3) || !(view?.length === 16) || !(model?.length === 16)) {
    return null;
  }
  const scale = fogScale(fogDensity, fogNear, fogFar);
  if (scale === 0) return null;
  const mv = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += view[k * 4 + row] * model[column * 4 + k];
      }
      mv[column * 4 + row] = sum;
    }
  }
  return {
    fadesAlpha: traits.fogAlpha === true,
    fogR: Math.round(Math.max(0, Math.min(1, fogColor[0])) * 255),
    fogG: Math.round(Math.max(0, Math.min(1, fogColor[1])) * 255),
    fogB: Math.round(Math.max(0, Math.min(1, fogColor[2])) * 255),
    transmittanceAt(x, y, z) {
      const ex = mv[0] * x + mv[4] * y + mv[8] * z + mv[12];
      const ey = mv[1] * x + mv[5] * y + mv[9] * z + mv[13];
      const ez = mv[2] * x + mv[6] * y + mv[10] * z + mv[14];
      const distance = Math.sqrt(ex * ex + ey * ey + ez * ez);
      return 2 ** (-scale * Math.max(distance - fogNear, 0));
    }
  };
}
function applyFogAlpha(transmittance, alpha) {
  return fogOpacityAt(transmittance) * alpha;
}
function applyFogChannel(fogChannel, channel, transmittance) {
  return Math.round(fogChannel + (channel - fogChannel) * transmittance);
}

// assets/js/app/ui/modules/figure-export/renderers/svg-point-markup.js
var HIGHLIGHT_RING_RADII = highlightRingRadii(HIGHLIGHT_STYLES_BY_QUALITY.light);
var HIGHLIGHT_FILL = `rgb(${HIGHLIGHT_RGB[0]},${HIGHLIGHT_RGB[1]},${HIGHLIGHT_RGB[2]})`;
var HIGHLIGHT_RING_STROKE = `rgb(${HIGHLIGHT_RING_COLOR.map((channel) => Math.round(channel * 255)).join(",")})`;
var SELECTION_MUTED_RGB = 160;
var MARKUP_BUFFER_BYTES = 1024 * 1024;
function createVectorPointShader({
  fog,
  positions,
  dimension,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity
}) {
  const shaded = new Float64Array(5);
  return function shadeVectorPoint(index, r, g, b, a) {
    let rr = r;
    let gg = g;
    let bb = b;
    let aa = a;
    let highlightFog = 1;
    if (emphasizeSelection && highlightArray && (highlightArray[index] ?? 0) < MIN_VISIBLE_ALPHA_BYTE) {
      rr = SELECTION_MUTED_RGB;
      gg = SELECTION_MUTED_RGB;
      bb = SELECTION_MUTED_RGB;
      aa *= selectionMutedOpacity;
    }
    if (fog !== null) {
      const base = index * dimension;
      const transmittance = fog.transmittanceAt(
        positions[base],
        dimension > 1 ? positions[base + 1] : 0,
        dimension > 2 ? positions[base + 2] : 0
      );
      highlightFog = fogOpacityAt(transmittance);
      if (fog.fadesAlpha) {
        aa = applyFogAlpha(transmittance, aa);
      } else {
        rr = applyFogChannel(fog.fogR, rr, transmittance);
        gg = applyFogChannel(fog.fogG, gg, transmittance);
        bb = applyFogChannel(fog.fogB, bb, transmittance);
      }
    }
    shaded[0] = rr;
    shaded[1] = gg;
    shaded[2] = bb;
    shaded[3] = aa;
    shaded[4] = highlightFog;
    return shaded;
  };
}
function highlightValueToAlpha01(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(
      "SVG highlight values must be exact Uint8 intensities."
    );
  }
  return value < MIN_VISIBLE_ALPHA_BYTE ? 0 : value / 255;
}
function createMarkupSink() {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(MARKUP_BUFFER_BYTES);
  const parts = [];
  let used = 0;
  const flush = () => {
    if (used === 0) return;
    parts.push(new Blob([buffer.subarray(0, used)]));
    used = 0;
  };
  return {
    write(text) {
      if (text.length * 3 > buffer.length - used) flush();
      if (text.length * 3 > buffer.length) {
        parts.push(new Blob([encoder.encode(text)]));
        return;
      }
      used += encoder.encodeInto(text, buffer.subarray(used)).written;
    },
    /** @returns {Blob} */
    finish() {
      flush();
      return new Blob(parts);
    }
  };
}
function writeCircle(sink, x, y, radius, shaded, highlightArray, index) {
  const r = shaded[0];
  const g = shaded[1];
  const b = shaded[2];
  const a = shaded[3];
  if (a < POINT_VISIBILITY_THRESHOLD) return;
  if (a >= 0.999) {
    sink.write(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${r},${g},${b})"/>`);
  } else {
    sink.write(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${r},${g},${b})" fill-opacity="${a.toFixed(3)}"/>`);
  }
  const h = highlightArray ? highlightValueToAlpha01(highlightArray[index] ?? 0) * shaded[4] : 0;
  if (h > 0) {
    const dotR = radius * HIGHLIGHT_RING_RADII.inner;
    const ringR = radius * (HIGHLIGHT_RING_RADII.inner + HIGHLIGHT_RING_RADII.outer) / 2;
    const ringWidth = radius * (HIGHLIGHT_RING_RADII.outer - HIGHLIGHT_RING_RADII.inner);
    const dotOpacity = h >= 0.999 ? "" : ` fill-opacity="${h.toFixed(3)}"`;
    sink.write(
      `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${dotR.toFixed(2)}" fill="${HIGHLIGHT_FILL}"${dotOpacity}/><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${ringR.toFixed(2)}" fill="none" stroke="${HIGHLIGHT_RING_STROKE}" stroke-width="${ringWidth.toFixed(2)}" stroke-opacity="${(0.95 * h).toFixed(3)}"/>`
    );
  }
}
function writeSvgPointMarkup({
  strategy,
  positions,
  dimension,
  colors,
  transparency,
  lodMembership,
  drawOrder,
  renderState,
  fogRenderState,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
  plotRect,
  crop,
  pointDiameterViewportPx,
  sortByDepth,
  targetCount,
  seed,
  pointLayers = null
}) {
  const layers = requireFigurePointLayers(pointLayers, "SVG point layers");
  const shadeVectorPoint = createVectorPointShader({
    fog: createFogEvaluator(fogRenderState),
    positions,
    dimension,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity
  });
  const sink = createMarkupSink();
  if (strategy === "optimized-vector") {
    const reduce = (mask, membership, count) => reducePointsByDensity({
      positions,
      dimension,
      colors,
      transparency: mask,
      lodMembership: membership,
      highlightArray,
      renderState,
      targetCount: count,
      seed,
      crop
    });
    let reductions;
    if (layers === null || colorLayersOf(colors).unread === 0) {
      reductions = [reduce(transparency, lodMembership, targetCount)];
    } else {
      const n = positions.length / dimension;
      const readMask = new Uint8Array(n);
      const unreadMask = new Uint8Array(n);
      for (let cell = 0; cell < n; cell++) {
        if (transparency !== null && transparency[cell] === 0) continue;
        if (colors[cell * 4 + 3] === UNREAD_ALPHA_BYTE) unreadMask[cell] = 1;
        else readMask[cell] = 1;
      }
      const read = reduce(readMask, layers.readEveryLevel ? null : lodMembership, targetCount);
      const rest = targetCount - read.x.length;
      reductions = rest > 0 ? [reduce(unreadMask, lodMembership, rest), read] : [read];
    }
    const { source, scale, viewportToPlot } = createPlotPlacement({ renderState, plotRect, crop });
    const origin = viewportToPlot(source.x, source.y);
    const offsetX = origin.x;
    const offsetY = origin.y;
    const diameterAt = createViewportPointDiameter(renderState);
    const radiusOf = (cell, pointSize) => {
      const at = cell * dimension;
      return diameterAt(
        positions[at],
        dimension > 1 ? positions[at + 1] : 0,
        dimension > 2 ? positions[at + 2] : 0,
        pointSize
      ) * scale * 0.5;
    };
    const layered = colors !== null && colorLayersOf(colors).layered;
    const unreadRgb = layers === null ? null : layers.unreadColor.map((channel) => Math.round(channel * 255));
    const zeroRgb = layers === null ? null : layers.zeroColor.map((channel) => Math.round(channel * 255));
    const readDiameter = pointDiameterViewportPx * (layers === null ? 1 : layers.readScale);
    const passBytes = [UNREAD_ALPHA_BYTE, BENEATH_ALPHA_BYTE, 255];
    for (let pass = layered ? 0 : 2; pass < 3; pass++) {
      for (const reduced of reductions) {
        for (let i = 0; i < reduced.x.length; i++) {
          const srcIndex = reduced.index?.[i] ?? i;
          const byte = colors === null ? 255 : colors[srcIndex * 4 + 3];
          const layer = byte === UNREAD_ALPHA_BYTE ? 0 : byte === BENEATH_ALPHA_BYTE ? 1 : 2;
          if (layered && passBytes[layer] !== passBytes[pass]) continue;
          const x = offsetX + reduced.x[i] * scale;
          const y = offsetY + reduced.y[i] * scale;
          const j = i * 4;
          const own = layer === 0 ? unreadRgb : layer === 1 ? zeroRgb : null;
          const shaded = shadeVectorPoint(
            srcIndex,
            own !== null ? own[0] : reduced.rgba[j],
            own !== null ? own[1] : reduced.rgba[j + 1],
            own !== null ? own[2] : reduced.rgba[j + 2],
            reduced.alpha[i] ?? 1
          );
          writeCircle(sink, x, y, radiusOf(srcIndex, layer === 0 ? pointDiameterViewportPx : readDiameter), shaded, highlightArray, srcIndex);
        }
      }
    }
    return sink.finish();
  }
  if (strategy !== "full-vector") {
    throw new TypeError(
      'SVG point markup requires strategy "full-vector" or "optimized-vector".'
    );
  }
  forEachProjectedPoint({
    positions,
    dimension,
    colors,
    // The cells' colors: the alpha byte is their layer.
    colorAlpha: "layer",
    transparency,
    lodMembership,
    drawOrder,
    renderState,
    plotRect,
    pointDiameterViewportPx,
    crop,
    sortByDepth,
    pointLayers: layers,
    onPoint: (x, y, r, g, b, a, radius, index) => {
      const shaded = shadeVectorPoint(index, r, g, b, a);
      writeCircle(sink, x, y, radius, shaded, highlightArray, index);
    }
  });
  return sink.finish();
}

// assets/js/utils/abort.js
var CANCEL_KINDS = Object.freeze(["user", "superseded", "closed", "released", "page-left"]);
var KINDS = new Set(CANCEL_KINDS);
function cancelled(kind, words, cause = void 0) {
  if (!KINDS.has(kind)) throw new RangeError(`Unknown cancellation kind '${String(kind)}'.`);
  if (typeof words !== "string" || words.length === 0) throw new TypeError("A cancellation says what stopped.");
  const error = new DOMException(words, "AbortError");
  Object.defineProperty(error, "kind", { value: kind, enumerable: true, configurable: true });
  if (cause !== void 0) Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
  return error;
}
function isCancellation(error) {
  return error?.name === "AbortError";
}
function cancellationKind(error) {
  if (!isCancellation(error)) return null;
  return KINDS.has(error.kind) ? error.kind : "user";
}
var SIGNAL_ABORTED = typeof AbortSignal === "function" ? Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null : null;

// assets/js/utils/errors.js
var REPORTED = /* @__PURE__ */ Symbol.for("cellucid.failureReported");
function isReported(error) {
  return error !== null && typeof error === "object" && error[REPORTED] === true;
}

// assets/js/utils/error-wire.js
var KEPT = ["code", "key", "reason", "bytes", "details", "columns", "feature", "offset", "status", "url"];
function toWire(error, seen = /* @__PURE__ */ new Set()) {
  if (error === null || typeof error !== "object" || typeof error.message !== "string") {
    return { name: "Error", message: String(error) };
  }
  const record = { name: typeof error.name === "string" ? error.name : "Error", message: error.message };
  seen.add(error);
  const kind = cancellationKind(error);
  if (kind !== null) record.kind = kind;
  if (isReported(error)) record.reported = true;
  if (typeof error.source === "string") record.sourceType = error.source;
  for (const key of KEPT) {
    if (key === "code" && typeof DOMException === "function" && error instanceof DOMException) continue;
    if (error[key] === void 0) continue;
    try {
      record[key] = structuredClone(error[key]);
    } catch {
      record[key] = String(error[key]);
    }
  }
  if (error.cause !== void 0 && !seen.has(error.cause)) record.cause = toWire(error.cause, seen);
  if (Array.isArray(error.errors)) record.errors = error.errors.filter((item) => !seen.has(item)).map((item) => toWire(item, seen));
  return record;
}

// assets/js/app/ui/modules/figure-export/utils/figure-export-worker.js
function resolveArrays(value, arrays) {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveArrays(item, arrays));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (Object.hasOwn(value, "$array")) {
    const array = arrays.get(value.$array);
    if (array === void 0) {
      throw new Error(`Figure-export worker has no array ${value.$array} in this session.`);
    }
    return array;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = resolveArrays(item, arrays);
  return out;
}
function reviveLodMembership(membership) {
  if (membership === null) return null;
  return Object.freeze({
    admissionLevels: membership.admissionLevels,
    count: membership.count,
    dimensionLevel: membership.dimensionLevel,
    generationToken: Object.freeze({}),
    indices: membership.indices,
    lodLevel: membership.lodLevel,
    pointCount: membership.pointCount
  });
}
function reviveRasterOptions(options) {
  return {
    ...options,
    lodMembership: reviveLodMembership(options.lodMembership)
  };
}
function pixelCanvas(pixels) {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const context = canvas.getContext("2d", { alpha: true });
  if (context === null) {
    throw new Error("Figure-export PNG encoding requires a Canvas 2D context.");
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}
async function encodeCanvasPng(canvas, failureMessage) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  if (!(blob instanceof Blob) || blob.type !== "image/png") {
    throw new Error(failureMessage);
  }
  return blob;
}
function blobToDataUrl(blob) {
  return new FileReaderSync().readAsDataURL(blob);
}
function placeRaster(pixels, placement) {
  const canvas = new OffscreenCanvas(placement.width, placement.height);
  const context = canvas.getContext("2d", { alpha: true });
  if (context === null) {
    throw new Error("SVG Hybrid raster scaling requires a Canvas 2D context");
  }
  context.drawImage(pixelCanvas(pixels), 0, 0, placement.width, placement.height);
  return canvas;
}
var operations = {
  webgl2: () => ({ result: webgl2RasterAvailable() }),
  spriteZoomLimit: () => ({ result: exportSpriteZoomLimit() }),
  rasterContext: ({ antialias }) => ({ result: describeRasterContext(antialias) }),
  drawnCells: (args) => ({
    result: sourceHasDrawnCells({ ...args, lodMembership: reviveLodMembership(args.lodMembership) })
  }),
  rasterizePoints: (args) => {
    const frame = rasterizePointsWebgl(reviveRasterOptions(args));
    return { result: frame, transfer: [frame] };
  },
  encodeRasterPngDataUrl: async ({ pixels, placement }) => {
    const canvas = placement === null ? pixelCanvas(pixels) : placeRaster(pixels, placement);
    const blob = await encodeCanvasPng(
      canvas,
      placement === null ? "SVG Hybrid point-pass PNG encoding failed" : "SVG Hybrid scaled point-pass PNG encoding failed"
    );
    return { result: blobToDataUrl(blob) };
  },
  svgPointMarkup: (args) => ({
    result: writeSvgPointMarkup({
      ...args,
      lodMembership: reviveLodMembership(args.lodMembership)
    })
  }),
  encodePng: async ({ pixels, text, dpi }) => {
    const blob = await encodeCanvasPng(pixelCanvas(pixels), "PNG encoding failed.");
    return { result: await embedPngMetadata(blob, { text, dpi }) };
  },
  encodePngDataUrl: async ({ pixels }) => {
    const blob = await encodeCanvasPng(pixelCanvas(pixels), "Figure-export PNG encoding failed.");
    return { result: blobToDataUrl(blob) };
  }
};
function createFigureExportWorkerHandler() {
  const sessions = /* @__PURE__ */ new Map();
  const pieces = /* @__PURE__ */ new Map();
  const cancelledSessions = /* @__PURE__ */ new Set();
  return async function handle(message) {
    const { id, op, session } = message;
    if (op === "cancel") {
      cancelledSessions.add(session);
      return null;
    }
    if (message.piece !== void 0) {
      let receiver = pieces.get(session);
      if (receiver === void 0) {
        receiver = new PieceReceiver();
        pieces.set(session, receiver);
      }
      receiver.receive(message.piece);
      return null;
    }
    if (op === "close") {
      sessions.delete(session);
      pieces.delete(session);
      cancelledSessions.delete(session);
      return null;
    }
    if (cancelledSessions.has(session)) {
      return { reply: { id, error: toWire(cancelled("user", "The figure export was canceled.")) }, transfer: [] };
    }
    try {
      let arrays = sessions.get(session);
      if (arrays === void 0) {
        arrays = /* @__PURE__ */ new Map();
        sessions.set(session, arrays);
      }
      const receiver = pieces.get(session);
      pieces.delete(session);
      const uploads = receiver === void 0 ? message.uploads : receiver.resolve(message.uploads);
      for (const [arrayId, array] of uploads) arrays.set(arrayId, array);
      const operation = Object.hasOwn(operations, op) ? operations[op] : void 0;
      if (operation === void 0) {
        throw new TypeError(`Figure-export worker has no operation "${op}".`);
      }
      const { result, transfer = [] } = await operation(resolveArrays(message.args, arrays));
      return { reply: { id, result }, transfer };
    } catch (error) {
      return { reply: { id, error: toWire(error) }, transfer: [] };
    }
  };
}
if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  const handle = createFigureExportWorkerHandler();
  let queue = Promise.resolve();
  self.onmessage = (event) => {
    if (event.data?.op === "cancel") {
      void handle(event.data);
      return;
    }
    queue = queue.then(async () => {
      const answer = await handle(event.data);
      if (answer !== null) self.postMessage(answer.reply, answer.transfer);
    });
  };
}
export {
  createFigureExportWorkerHandler
};
//# sourceMappingURL=figure-export-worker.57ecbe5dda80.js.map
