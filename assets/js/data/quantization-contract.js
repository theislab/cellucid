/**
 * The sole current scientific metadata contract for quantized field decoding.
 *
 * @module data/quantization-contract
 */

const METADATA_KEYS = ['dtype', 'bits', 'minValue', 'maxValue'];
const TASK_KEYS = ['buffer', ...METADATA_KEYS];

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
 * Name compact_v1's constant-field case from one payload's published bounds.
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
 * @param {Object} task
 * @param {ArrayBuffer} task.buffer
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
  validateQuantizationMetadata({
    dtype: task.dtype,
    bits: task.bits,
    minValue: task.minValue,
    maxValue: task.maxValue,
  }, label);
  if (task.dtype === 'uint16' && task.buffer.byteLength % 2 !== 0) {
    throw new Error(`${label} uint16 buffer byte length must be a multiple of 2`);
  }
  return task;
}
