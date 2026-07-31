/**
 * Quantization Worker
 *
 * Off-main-thread dequantization for quantized uint8/uint16 fields.
 * Used by data loaders to keep UI responsive and to parallelize decoding.
 *
 * @module data/quantization-worker
 */

import {
  isConstantQuantizationRange,
  validateQuantizationTask,
} from './quantization-contract.js';

/**
 * @typedef {{
 *   buffer: ArrayBuffer,
 *   dtype: 'uint8'|'uint16',
 *   minValue: number,
 *   maxValue: number,
 *   bits: 8|16
 * }} DequantizePayload
 */

/**
 * @param {DequantizePayload} payload
 * @returns {ArrayBuffer} Float32Array buffer
 */
export function dequantizeToFloat32Buffer(payload) {
  validateQuantizationTask(payload, 'Quantization worker task');
  const { buffer, dtype, minValue, maxValue } = payload;
  const isU8 = dtype === 'uint8';
  const quantized = isU8 ? new Uint8Array(buffer) : new Uint16Array(buffer);

  const n = quantized.length;
  const out = new Float32Array(n);

  const maxQuant = isU8 ? 254 : 65534;
  const nanMarker = isU8 ? 255 : 65535;

  if (isConstantQuantizationRange(minValue, maxValue)) {
    // compact_v1's constant-field case: equal bounds, every code 0. Return the
    // constant itself instead of scaling by a range of zero.
    for (let i = 0; i < n; i++) {
      out[i] = quantized[i] === nanMarker ? NaN : minValue;
    }
    return out.buffer;
  }

  const scale = (maxValue - minValue) / maxQuant;

  for (let i = 0; i < n; i++) {
    const q = quantized[i];
    out[i] = q === nanMarker ? NaN : minValue + q * scale;
  }

  return out.buffer;
}

function validateWorkerMessage(message) {
  if (
    message === null ||
    typeof message !== 'object' ||
    Array.isArray(message)
  ) {
    throw new Error('Quantization worker message must be an object');
  }
  const expectedKeys = ['type', 'payload', 'requestId'];
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(message);
  if (
    expectedKeys.some(key => !Object.hasOwn(message, key)) ||
    actualKeys.some(key => !expected.has(key))
  ) {
    throw new Error(
      'Quantization worker message requires exactly type, payload, and requestId'
    );
  }
  if (message.type !== 'DEQUANTIZE_TO_F32') {
    throw new Error(
      `Unknown quantization worker message type: ${String(message.type)}`
    );
  }
  if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
    throw new Error(
      'Quantization worker message requestId must be a non-empty string'
    );
  }
  validateQuantizationTask(
    message.payload,
    'Quantization worker message payload'
  );
  return message;
}

export function processQuantizationWorkerMessage(message) {
  const { payload, requestId } = validateWorkerMessage(message);
  const outBuffer = dequantizeToFloat32Buffer(payload);
  return {
    requestId,
    success: true,
    result: { buffer: outBuffer },
  };
}

if (typeof self !== 'undefined') {
  self.onmessage = event => {
    const message = event.data;
    try {
      const response = processQuantizationWorkerMessage(message);
      self.postMessage(response, [response.result.buffer]);
    } catch (error) {
      const requestId = (
        message !== null &&
        typeof message === 'object' &&
        typeof message.requestId === 'string'
      )
        ? message.requestId
        : null;
      self.postMessage({
        requestId,
        success: false,
        error: error instanceof Error
          ? error.message
          : 'Quantization worker failed with a non-Error value',
      });
    }
  };
}
