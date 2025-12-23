/**
 * @fileoverview Packed per-item texture helpers.
 *
 * These helpers upload 1D per-cell arrays into 2D textures, avoiding GPU buffer
 * readbacks and avoiding padded CPU copies for large datasets by streaming
 * row-by-row with `texSubImage2D`.
 *
 * @module rendering/overlays/shared/packed-texture
 */

/**
 * Compute width/height for a packed 2D texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} itemCount
 */
export function computePackedDims(gl, itemCount) {
  const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const count = Math.max(0, Math.floor(itemCount || 0));
  const width = Math.max(1, Math.min(count || 1, maxTexSize));
  const height = Math.max(1, Math.ceil((count || 1) / width));
  if (height > maxTexSize) {
    throw new Error(`Packed texture dims ${width}x${height} exceed MAX_TEXTURE_SIZE=${maxTexSize}`);
  }
  return { width, height, maxTexSize };
}

/**
 * Create or replace a packed float texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {WebGLTexture|null} [options.texture]
 * @param {Float32Array} options.data
 * @param {number} options.itemCount
 * @param {1|2|3|4} options.components
 * @returns {{ texture: WebGLTexture, width: number, height: number, components: number }}
 */
export function createOrUpdatePackedFloatTexture(gl, options) {
  const { texture: existing = null, data, itemCount, components } = options || {};

  const comps = components === 1 || components === 2 || components === 3 || components === 4 ? components : 3;
  const count = Math.max(0, Math.floor(itemCount || 0));
  if (!(data instanceof Float32Array)) {
    throw new Error('createOrUpdatePackedFloatTexture: data must be Float32Array');
  }
  if (data.length < count * comps) {
    throw new Error(`createOrUpdatePackedFloatTexture: data length ${data.length} < expected ${count * comps}`);
  }

  const { width, height } = computePackedDims(gl, count);

  const internalFormat =
    comps === 1 ? gl.R32F :
    comps === 2 ? gl.RG32F :
    comps === 3 ? gl.RGB32F :
    gl.RGBA32F;
  const format =
    comps === 1 ? gl.RED :
    comps === 2 ? gl.RG :
    comps === 3 ? gl.RGB :
    gl.RGBA;

  const texture = existing || gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Allocate storage, then stream rows to avoid padded CPU copies.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.FLOAT, null);

  let remaining = count;
  let srcOffset = 0;
  for (let y = 0; y < height && remaining > 0; y++) {
    const rowItems = Math.min(width, remaining);
    const rowLen = rowItems * comps;
    const row = data.subarray(srcOffset, srcOffset + rowLen);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, rowItems, 1, format, gl.FLOAT, row);
    remaining -= rowItems;
    srcOffset += rowLen;
  }

  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width, height, components: comps };
}

/**
 * Create or replace a packed unsigned-int texture (R32UI).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {WebGLTexture|null} [options.texture]
 * @param {Uint32Array} options.data
 * @param {number} options.itemCount
 * @returns {{ texture: WebGLTexture, width: number, height: number }}
 */
export function createOrUpdatePackedUintTexture(gl, options) {
  const { texture: existing = null, data, itemCount } = options || {};

  const count = Math.max(0, Math.floor(itemCount || 0));
  if (!(data instanceof Uint32Array)) {
    throw new Error('createOrUpdatePackedUintTexture: data must be Uint32Array');
  }
  if (data.length < count) {
    throw new Error(`createOrUpdatePackedUintTexture: data length ${data.length} < expected ${count}`);
  }

  const { width, height } = computePackedDims(gl, count);

  const texture = existing || gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);

  let remaining = count;
  let srcOffset = 0;
  for (let y = 0; y < height && remaining > 0; y++) {
    const rowItems = Math.min(width, remaining);
    const row = data.subarray(srcOffset, srcOffset + rowItems);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, rowItems, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, row);
    remaining -= rowItems;
    srcOffset += rowItems;
  }

  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width, height };
}
