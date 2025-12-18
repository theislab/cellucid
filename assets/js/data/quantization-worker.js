/**
 * Quantization Worker
 *
 * Off-main-thread dequantization for quantized uint8/uint16 fields.
 * Used by data loaders to keep UI responsive and to parallelize decoding.
 *
 * @module data/quantization-worker
 */

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
function dequantizeToFloat32Buffer(payload) {
  const { buffer, dtype, minValue, maxValue, bits } = payload || {};
  const isU8 = dtype === 'uint8' || bits === 8;
  const quantized = isU8 ? new Uint8Array(buffer) : new Uint16Array(buffer);

  const n = quantized.length;
  const out = new Float32Array(n);

  const maxQuant = isU8 ? 254 : 65534;
  const nanMarker = isU8 ? 255 : 65535;

  const range = (Number.isFinite(maxValue) ? maxValue : 0) - (Number.isFinite(minValue) ? minValue : 0);
  const scale = range / maxQuant;
  const base = Number.isFinite(minValue) ? minValue : 0;

  for (let i = 0; i < n; i++) {
    const q = quantized[i];
    out[i] = q === nanMarker ? NaN : base + q * scale;
  }

  return out.buffer;
}

self.onmessage = (e) => {
  const msg = e?.data;
  const { type, payload, requestId } = msg || {};

  try {
    if (type === 'DEQUANTIZE_TO_F32') {
      const outBuffer = dequantizeToFloat32Buffer(payload);
      self.postMessage({ requestId, success: true, result: { buffer: outBuffer } }, [outBuffer]);
      return;
    }

    self.postMessage({
      requestId,
      success: false,
      error: `Unknown worker message type: ${String(type)}`
    });
  } catch (err) {
    self.postMessage({
      requestId,
      success: false,
      error: err?.message || String(err)
    });
  }
};

