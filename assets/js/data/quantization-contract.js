/**
 * The sole current scientific metadata contract for quantized field decoding.
 *
 * @module data/quantization-contract
 */

const METADATA_KEYS = ['dtype', 'bits', 'minValue', 'maxValue'];
const TASK_KEYS = ['buffer', 'gzipOutputBytes', ...METADATA_KEYS];

function requireExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  const missing = expectedKeys.filter(key => !Object.hasOwn(value, key));
  const extra = actualKeys.filter(key => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`);
    if (extra.length > 0) details.push(`unexpected ${extra.join(', ')}`);
    throw new Error(`${label} properties are invalid: ${details.join('; ')}`);
  }
}

/**
 * Name the compact manifests' constant-field case from one payload's published bounds.
 *
 * A gene detected in no published cell, or an obs column a subset flattened, is
 * ordinary scientific data, so the format encodes it rather than dropping it:
 * equal bounds and every code 0, in an entry whose shape and length are
 * unchanged. Every decoder here branches on this rather than scaling by a range
 * of zero, so a constant field yields its exact value in place of the NaN or
 * Infinity that dividing by the bounds would produce for every cell.
 *
 * Sole derivation point on the reader side, and the exact peer of
 * `_is_constant_continuous_range` in the Python exporter and
 * `.is_constant_continuous_range` in the R exporter.
 *
 * @param {number} minValue
 * @param {number} maxValue
 * @returns {boolean}
 */
export function isConstantQuantizationRange(minValue, maxValue) {
  return minValue === maxValue;
}

/**
 * @param {Object} metadata
 * @param {'uint8'|'uint16'} metadata.dtype
 * @param {8|16} metadata.bits
 * @param {number} metadata.minValue
 * @param {number} metadata.maxValue
 * @param {string} [label]
 * @returns {Object}
 */
export function validateQuantizationMetadata(
  metadata,
  label = 'Quantization metadata'
) {
  requireExactKeys(metadata, METADATA_KEYS, label);
  const { dtype, bits, minValue, maxValue } = metadata;
  const exactPair =
    (dtype === 'uint8' && bits === 8) ||
    (dtype === 'uint16' && bits === 16);
  if (!exactPair) {
    throw new Error(
      `${label} dtype and bits must be exactly "uint8"/8 or "uint16"/16`
    );
  }
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    throw new Error(`${label} bounds must be finite`);
  }
  // Equal bounds are the constant-field case, not a defect.
  if (!(minValue <= maxValue)) {
    throw new Error(`${label} minValue must not exceed maxValue`);
  }
  return metadata;
}

/**
 * Validate one decode task: a payload transfer plus its quantization codec.
 *
 * `buffer` is the payload exactly as it was transferred. `gzipOutputBytes` is
 * null when the transfer is the code array itself, and the exact inflated
 * length when the transfer is one gzip member: the decoder then inflates it
 * under that bound before reading any code, so a compressed payload is decoded
 * in the same place — and with the same bomb bound — as it is dequantized.
 *
 * @param {Object} task
 * @param {ArrayBuffer} task.buffer
 * @param {number|null} task.gzipOutputBytes
 * @param {'uint8'|'uint16'} task.dtype
 * @param {8|16} task.bits
 * @param {number} task.minValue
 * @param {number} task.maxValue
 * @param {string} [label]
 * @returns {Object}
 */
export function validateQuantizationTask(
  task,
  label = 'Quantization task'
) {
  requireExactKeys(task, TASK_KEYS, label);
  if (!(task.buffer instanceof ArrayBuffer)) {
    throw new Error(`${label} buffer must be an ArrayBuffer`);
  }
  if (
    task.gzipOutputBytes !== null &&
    (!Number.isSafeInteger(task.gzipOutputBytes) || task.gzipOutputBytes < 0)
  ) {
    throw new Error(
      `${label} gzipOutputBytes must be null or a non-negative safe integer`
    );
  }
  validateQuantizationMetadata({
    dtype: task.dtype,
    bits: task.bits,
    minValue: task.minValue,
    maxValue: task.maxValue,
  }, label);
  if (task.dtype === 'uint16' && decodedCodeByteLength(task) % 2 !== 0) {
    throw new Error(`${label} uint16 buffer byte length must be a multiple of 2`);
  }
  return task;
}

/**
 * Byte length of a validated task's code array once any gzip is inflated.
 * @param {{buffer: ArrayBuffer, gzipOutputBytes: number|null}} task
 * @returns {number}
 */
export function decodedCodeByteLength(task) {
  return task.gzipOutputBytes === null
    ? task.buffer.byteLength
    : task.gzipOutputBytes;
}

/**
 * Decode quantized codes to Float32 values — the one decoding kernel shared by
 * the quantization worker and the main-thread loader.
 *
 * Every code decodes through a table built once per payload: one entry per
 * possible code (256 for 8-bit, 65,536 for 16-bit), holding exactly the value
 * the per-cell formula `minValue + code * scale` rounds to in Float32, NaN at
 * the missing marker, and the constant itself in the constant-field case. The
 * per-cell work is then a single indexed copy. Building the entry from the
 * same double expression and storing it into a Float32Array is the same
 * rounding the per-cell store performed, so every decoded value is bit
 * identical — and a 500,000-cell gene decodes roughly nine times faster than
 * evaluating the formula with a branch in every cell.
 *
 * @param {Uint8Array|Uint16Array} quantized - Codes, already validated
 * @param {number} minValue
 * @param {number} maxValue
 * @param {8|16} bits
 * @returns {Float32Array}
 */
export function decodeQuantizedToFloat32(quantized, minValue, maxValue, bits) {
  const nanMarker = bits === 8 ? 255 : 65535;
  const maxQuant = nanMarker - 1;
  const table = new Float32Array(nanMarker + 1);
  if (isConstantQuantizationRange(minValue, maxValue)) {
    // the compact manifests' constant-field case: equal bounds, every code 0. Return the
    // constant itself instead of scaling by a range of zero.
    table.fill(minValue, 0, nanMarker);
  } else {
    const scale = (maxValue - minValue) / maxQuant;
    for (let code = 0; code < nanMarker; code++) {
      table[code] = minValue + code * scale;
    }
  }
  table[nanMarker] = NaN;

  const n = quantized.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = table[quantized[i]];
  return out;
}
