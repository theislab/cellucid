/**
 * Quantization Worker
 *
 * Off-main-thread decoding for quantized uint8/uint16 fields: the gzip
 * inflate of a compressed transfer and the dequantization of its codes both
 * run here. Used by data loaders to keep UI responsive and to parallelize
 * decoding — streaming analyses decode one payload per gene, so the inflate
 * left on the main thread was the largest single cost per gene there.
 *
 * @module data/quantization-worker
 */

import {
  decodeQuantizedToFloat32,
  validateQuantizationTask,
} from './quantization-contract.js';
import { gzipDecompress } from '../app/session/codecs/gzip.js';

/**
 * @typedef {{
 *   buffer: ArrayBuffer,
 *   gzipOutputBytes: number|null,
 *   dtype: 'uint8'|'uint16',
 *   minValue: number,
 *   maxValue: number,
 *   bits: 8|16
 * }} DequantizePayload
 */

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer} A buffer holding exactly `bytes`, from offset 0.
 */
function exactBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

/**
 * @param {DequantizePayload} payload
 * @returns {Promise<ArrayBuffer>} Float32Array buffer
 */
export async function dequantizeToFloat32Buffer(payload) {
  validateQuantizationTask(payload, 'Quantization worker task');
  const { buffer, gzipOutputBytes, dtype, minValue, maxValue, bits } = payload;
  const codes = gzipOutputBytes === null
    ? buffer
    : exactBuffer(await gzipDecompress(new Uint8Array(buffer), {
      maxOutputBytes: gzipOutputBytes,
      signal: null,
    }));
  const quantized = dtype === 'uint8'
    ? new Uint8Array(codes)
    : new Uint16Array(codes);
  return decodeQuantizedToFloat32(quantized, minValue, maxValue, bits).buffer;
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

export async function processQuantizationWorkerMessage(message) {
  const { payload, requestId } = validateWorkerMessage(message);
  const outBuffer = await dequantizeToFloat32Buffer(payload);
  return {
    requestId,
    success: true,
    result: { buffer: outBuffer },
  };
}

if (typeof self !== 'undefined') {
  self.onmessage = async event => {
    const message = event.data;
    try {
      const response = await processQuantizationWorkerMessage(message);
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
