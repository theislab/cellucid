/**
 * Linear textures: one texel per item of a per-cell (or per-word) array,
 * addressable at any size an engine can allocate.
 *
 * A per-item array used to go into one 2D texture, `MAX_TEXTURE_SIZE` texels
 * a row, which caps it at `MAX_TEXTURE_SIZE^2` items: 67,108,864 where the
 * engine reports 8192 (Firefox on macOS, some mobile GPUs), so a 3-D
 * position gather (three words a point) failed above 22.4M points there and
 * every per-cell texture above 67.1M cells. A linear texture is a
 * `TEXTURE_2D_ARRAY`: rows of a power-of-two width, stacked into as many
 * layers as the count needs (`MAX_ARRAY_TEXTURE_LAYERS` is at least 256, so
 * the capacity is at least 2^34 items even at 8192).
 *
 * Every size uses the same layout and the same shader addressing, so there
 * is one path whatever the count: a small array is one layer of a few rows.
 * The shader finds the column and row with a mask and a power-of-two shift;
 * only the layer needs a division, by the rows a layer holds. Several rows
 * are exactly that power of two wide. A single row is exactly as wide as the
 * items (the shift still addresses it: every index is below 2^shift), so the
 * first upload covers the whole image: an image a first upload covers only
 * in part is cleared by Firefox before the write ("lazy initialization"),
 * an extra full-size zero upload.
 *
 * The bytes in the texture are the source bytes, item for item, in order.
 */

import { formatCountOf } from '../utils/format-units.js';

/** GLSL: the texel of item `index` in a linear texture laid out as `layout`. */
export const LINEAR_TEXEL_GLSL = `
// The texel of item \`index\` in a linear texture (rendering/linear-texture.js):
// shape.x = log2(width), shape.y = rows per layer. (\`layout\` is a GLSL
// keyword, which Firefox's compiler rejects as a name.)
ivec3 linearTexel(int index, ivec2 shape) {
  int row = index >> shape.x;
  int layer = row / shape.y;
  return ivec3(index & ((1 << shape.x) - 1), row - layer * shape.y, layer);
}
`;

function floorLog2(value) {
  return 31 - Math.clz32(value);
}

/**
 * Plan the layout of a linear texture for `itemCount` items.
 *
 * @param {number} itemCount - Items (texels) to hold; 0 plans one texel.
 * @param {number} maxTextureSize - `MAX_TEXTURE_SIZE`.
 * @param {number} maxArrayLayers - `MAX_ARRAY_TEXTURE_LAYERS`.
 * @returns {Readonly<{itemCount: number, width: number, widthShift: number,
 *   rowsPerLayer: number, layers: number, rows: number, texels: number}>}
 */
export function planLinearTexture(itemCount, maxTextureSize, maxArrayLayers) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new RangeError(`Linear texture item count must be a non-negative safe integer, not ${itemCount}.`);
  }
  if (!Number.isSafeInteger(maxTextureSize) || maxTextureSize <= 0) {
    throw new RangeError('Linear texture needs a positive MAX_TEXTURE_SIZE.');
  }
  if (!Number.isSafeInteger(maxArrayLayers) || maxArrayLayers <= 0) {
    throw new RangeError('Linear texture needs a positive MAX_ARRAY_TEXTURE_LAYERS.');
  }
  const count = Math.max(1, itemCount);
  const maxShift = floorLog2(maxTextureSize);
  const neededShift = count <= 1 ? 0 : floorLog2(count - 1) + 1;
  const widthShift = Math.min(maxShift, neededShift);
  const rows = Math.ceil(count / 2 ** widthShift);
  // One row: exactly the items wide (see above).
  const width = rows === 1 ? count : 2 ** widthShift;
  const layers = Math.ceil(rows / maxTextureSize);
  if (layers > maxArrayLayers) {
    throw new RangeError(
      `${formatCountOf(itemCount, 'item')} need ${layers} texture layers; this GPU allows ${maxArrayLayers}.`
    );
  }
  const rowsPerLayer = Math.ceil(rows / layers);
  // Shader indices are signed 32-bit integers.
  if (count > 2 ** 31 - 1) {
    throw new RangeError(`${formatCountOf(itemCount, 'item')} exceed the shader's integer index range.`);
  }
  return Object.freeze({
    itemCount,
    width,
    widthShift,
    rowsPerLayer,
    layers,
    rows,
    texels: width * rowsPerLayer * layers,
  });
}

/**
 * Plan a linear texture from the context's limits.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} itemCount
 */
export function planLinearTextureFor(gl, itemCount) {
  return planLinearTexture(
    itemCount,
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
    gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)
  );
}

/** The texel of item `index` under `plan`, as `[x, y, layer]` (for tests and CPU readers). */
export function linearTexelOf(plan, index) {
  const row = Math.floor(index / plan.width);
  const layer = Math.floor(row / plan.rowsPerLayer);
  return [index - row * plan.width, row - layer * plan.rowsPerLayer, layer];
}

/**
 * Allocate immutable storage for `plan` on the `TEXTURE_2D_ARRAY` bound to
 * the active unit, with nearest filtering and edge clamping.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} internalFormat
 * @param {ReturnType<typeof planLinearTexture>} plan
 */
export function allocateLinearTexture(gl, internalFormat, plan) {
  const target = gl.TEXTURE_2D_ARRAY;
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage3D(target, 1, internalFormat, plan.width, plan.rowsPerLayer, plan.layers);
}

/**
 * Write the items of rows `[rowStart, rowEnd)` from `data` into the
 * `TEXTURE_2D_ARRAY` bound to the active unit. `data` holds every item from
 * item 0, `componentsPerTexel` elements an item (it may be padded to whole
 * rows); the last row may be partial and is written at its exact width.
 * Sources are addressed by offset, so a write allocates nothing. The caller
 * sets the unpack
 * state (alignment that fits the row bytes, no row length or skips, no
 * unpack buffer).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {ReturnType<typeof planLinearTexture>} plan
 * @param {number} format
 * @param {number} type
 * @param {ArrayBufferView} data
 * @param {number} componentsPerTexel
 * @param {number} [rowStart=0]
 * @param {number} [rowEnd=plan.rows]
 * @returns {number} Bytes written.
 */
export function writeLinearTextureRows(
  gl, plan, format, type, data, componentsPerTexel, rowStart = 0, rowEnd = plan.rows
) {
  const itemCount = plan.itemCount;
  const width = plan.width;
  const lastRow = Math.min(rowEnd, Math.ceil(itemCount / width));
  // A source padded to whole rows is written in whole rows (its padding
  // included), so the texture image equals the source image exactly.
  const fullRows = data.length >= lastRow * width * componentsPerTexel
    ? lastRow
    : Math.floor(itemCount / width);
  let bytes = 0;
  let row = Math.max(0, rowStart);
  while (row < lastRow) {
    const layer = Math.floor(row / plan.rowsPerLayer);
    const layerEnd = Math.min(lastRow, (layer + 1) * plan.rowsPerLayer);
    const y = row - layer * plan.rowsPerLayer;
    const fullEnd = Math.min(layerEnd, fullRows);
    if (row < fullEnd) {
      const begin = row * width * componentsPerTexel;
      const end = fullEnd * width * componentsPerTexel;
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, 0, 0, y, layer, width, fullEnd - row, 1,
        format, type, data, begin
      );
      bytes += (end - begin) * data.BYTES_PER_ELEMENT;
      row = fullEnd;
      continue;
    }
    // The partial last row.
    const remainder = itemCount - row * width;
    const begin = row * width * componentsPerTexel;
    const end = begin + remainder * componentsPerTexel;
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, y, layer, remainder, 1, 1,
      format, type, data, begin
    );
    bytes += (end - begin) * data.BYTES_PER_ELEMENT;
    row += 1;
  }
  return bytes;
}

/**
 * Set the `ivec2` layout uniform of a linear texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLUniformLocation|null} location
 * @param {ReturnType<typeof planLinearTexture>} plan
 */
export function setLinearLayoutUniform(gl, location, plan) {
  if (location !== null) gl.uniform2i(location, plan.widthShift, plan.rowsPerLayer);
}
