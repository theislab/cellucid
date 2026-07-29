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
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new RangeError(
      'Packed texture itemCount must be a non-negative safe integer.'
    );
  }
  const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (!Number.isSafeInteger(maxTexSize) || maxTexSize <= 0) {
    throw new Error('WebGL MAX_TEXTURE_SIZE must be a positive safe integer.');
  }
  const packedCount = itemCount === 0 ? 1 : itemCount;
  const width = Math.min(packedCount, maxTexSize);
  const height = Math.ceil(packedCount / width);
  if (height > maxTexSize) {
    throw new Error(`Packed texture dims ${width}x${height} exceed MAX_TEXTURE_SIZE=${maxTexSize}`);
  }
  return { width, height, maxTexSize };
}

function uploadStagedTexture(gl, existing, label, upload) {
  if (existing !== null && !gl.isTexture(existing)) {
    throw new TypeError(`${label} existing texture is not owned by WebGL.`);
  }
  const priorError = gl.getError();
  if (priorError !== gl.NO_ERROR) {
    throw new Error(
      `${label} cannot start while WebGL error 0x${priorError.toString(16)} is pending.`
    );
  }
  const previousBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
  const previousPixelUnpackBuffer =
    gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
  const candidate = gl.createTexture();
  if (candidate === null) {
    throw new Error(`WebGL failed to allocate ${label}.`);
  }
  const restoreBinding = previousBinding === existing
    ? candidate
    : previousBinding;
  try {
    gl.bindTexture(gl.TEXTURE_2D, candidate);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    upload();
    const uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
      throw new Error(
        `${label} upload failed with WebGL error 0x${uploadError.toString(16)}.`
      );
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
    gl.bindBuffer(
      gl.PIXEL_UNPACK_BUFFER,
      previousPixelUnpackBuffer
    );
    gl.bindTexture(gl.TEXTURE_2D, restoreBinding);
  } catch (error) {
    const cleanupErrors = [];
    for (const cleanup of [
      () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment),
      () => gl.bindBuffer(
        gl.PIXEL_UNPACK_BUFFER,
        previousPixelUnpackBuffer
      ),
      () => gl.bindTexture(gl.TEXTURE_2D, previousBinding),
      () => gl.deleteTexture(candidate)
    ]) {
      try {
        cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${label} upload failed and cleanup was incomplete.`
      );
    }
    throw error;
  }
  if (existing !== null) {
    try {
      gl.deleteTexture(existing);
    } catch (error) {
      // A host wrapper may perform the WebGL deletion and then throw. In that
      // case the replacement has already committed and rolling the candidate
      // back would leave the caller with no live texture at all.
      let existingIsLive;
      try {
        existingIsLive = gl.isTexture(existing);
      } catch (inspectionError) {
        const ownershipErrors = [error, inspectionError];
        try {
          gl.deleteTexture(candidate);
        } catch (cleanupError) {
          ownershipErrors.push(cleanupError);
        }
        throw new AggregateError(
          ownershipErrors,
          `${label} replacement retirement state could not be determined; candidate cleanup was attempted.`
        );
      }
      if (!existingIsLive) return candidate;
      const cleanupErrors = [];
      for (const cleanup of [
        () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment),
        () => gl.bindBuffer(
          gl.PIXEL_UNPACK_BUFFER,
          previousPixelUnpackBuffer
        ),
        () => gl.bindTexture(gl.TEXTURE_2D, previousBinding),
        () => gl.deleteTexture(candidate)
      ]) {
        try {
          cleanup();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `${label} replacement retirement failed and cleanup was incomplete.`
        );
      }
      throw error;
    }
  }
  return candidate;
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
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).sort().join(',') !==
      'components,data,itemCount,texture'
  ) {
    throw new TypeError(
      'Packed float texture options must contain exactly components, data, itemCount, and texture.'
    );
  }
  const {
    texture: existing,
    data,
    itemCount: count,
    components: comps
  } = options;
  if (existing !== null && typeof existing !== 'object') {
    throw new TypeError('Packed float texture must be a WebGLTexture or null.');
  }
  if (![1, 2, 3, 4].includes(comps)) {
    throw new RangeError('Packed float texture components must be exactly 1, 2, 3, or 4.');
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(
      'Packed float texture itemCount must be a non-negative safe integer.'
    );
  }
  if (!(data instanceof Float32Array)) {
    throw new TypeError('Packed float texture data must be a Float32Array.');
  }
  if (data.length !== count * comps) {
    throw new RangeError(
      `Packed float texture data must contain exactly ${count * comps} values; received ${data.length}.`
    );
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

  const texture = uploadStagedTexture(
    gl,
    existing,
    'packed float texture',
    () => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Allocate storage, then stream rows to avoid padded CPU copies.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        width,
        height,
        0,
        format,
        gl.FLOAT,
        null
      );

      let remaining = count;
      let srcOffset = 0;
      for (let y = 0; y < height && remaining > 0; y++) {
        const rowItems = Math.min(width, remaining);
        const rowLen = rowItems * comps;
        const row = data.subarray(srcOffset, srcOffset + rowLen);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          y,
          rowItems,
          1,
          format,
          gl.FLOAT,
          row
        );
        remaining -= rowItems;
        srcOffset += rowLen;
      }
    }
  );
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
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).sort().join(',') !== 'data,itemCount,texture'
  ) {
    throw new TypeError(
      'Packed uint texture options must contain exactly data, itemCount, and texture.'
    );
  }
  const { texture: existing, data, itemCount: count } = options;
  if (existing !== null && typeof existing !== 'object') {
    throw new TypeError('Packed uint texture must be a WebGLTexture or null.');
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(
      'Packed uint texture itemCount must be a non-negative safe integer.'
    );
  }
  if (!(data instanceof Uint32Array)) {
    throw new TypeError('Packed uint texture data must be a Uint32Array.');
  }
  if (data.length !== count) {
    throw new RangeError(
      `Packed uint texture data must contain exactly ${count} values; received ${data.length}.`
    );
  }

  const { width, height } = computePackedDims(gl, count);

  const texture = uploadStagedTexture(
    gl,
    existing,
    'packed uint texture',
    () => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32UI,
        width,
        height,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        null
      );

      let remaining = count;
      let srcOffset = 0;
      for (let y = 0; y < height && remaining > 0; y++) {
        const rowItems = Math.min(width, remaining);
        const row = data.subarray(srcOffset, srcOffset + rowItems);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          y,
          rowItems,
          1,
          gl.RED_INTEGER,
          gl.UNSIGNED_INT,
          row
        );
        remaining -= rowItems;
        srcOffset += rowItems;
      }
    }
  );
  return { texture, width, height };
}
