// Build a 3D density volume (gridSize^3) from normalized positions in [-1, 1]^3.
// This runs once on the CPU and decouples rendering cost from number of points.
export function buildDensityVolume(positions, options = {}) {
  const gridSize = Math.max(8, options.gridSize || 128); // 128^3 default for sharper density
  const gamma = options.gamma != null ? options.gamma : 0.75; // contrast curve

  const pointCount = positions.length / 3;
  const volume = new Float32Array(gridSize * gridSize * gridSize);

  const halfExtent = 1.0;
  const minCoord = -halfExtent;
  const maxCoord = halfExtent;

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // Map [-1, 1] -> [0, gridSize-1] and splat with trilinear weights
  for (let i = 0; i < pointCount; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];

    // Skip extreme outliers just in case
    if (x < minCoord || x > maxCoord ||
        y < minCoord || y > maxCoord ||
        z < minCoord || z > maxCoord) {
      continue;
    }

    const fx = (x - minCoord) / (maxCoord - minCoord) * (gridSize - 1);
    const fy = (y - minCoord) / (maxCoord - minCoord) * (gridSize - 1);
    const fz = (z - minCoord) / (maxCoord - minCoord) * (gridSize - 1);

    const ix0 = clamp(Math.floor(fx), 0, gridSize - 1);
    const iy0 = clamp(Math.floor(fy), 0, gridSize - 1);
    const iz0 = clamp(Math.floor(fz), 0, gridSize - 1);

    const tx = fx - ix0;
    const ty = fy - iy0;
    const tz = fz - iz0;

    const ix1 = ix0 < gridSize - 1 ? ix0 + 1 : ix0;
    const iy1 = iy0 < gridSize - 1 ? iy0 + 1 : iy0;
    const iz1 = iz0 < gridSize - 1 ? iz0 + 1 : iz0;

    const wx0 = 1.0 - tx, wx1 = tx;
    const wy0 = 1.0 - ty, wy1 = ty;
    const wz0 = 1.0 - tz, wz1 = tz;

    function add(ix, iy, iz, w) {
      const idx = ix + gridSize * (iy + gridSize * iz);
      volume[idx] += w;
    }

    add(ix0, iy0, iz0, wx0 * wy0 * wz0);
    add(ix1, iy0, iz0, wx1 * wy0 * wz0);
    add(ix0, iy1, iz0, wx0 * wy1 * wz0);
    add(ix1, iy1, iz0, wx1 * wy1 * wz0);
    add(ix0, iy0, iz1, wx0 * wy0 * wz1);
    add(ix1, iy0, iz1, wx1 * wy0 * wz1);
    add(ix0, iy1, iz1, wx0 * wy1 * wz1);
    add(ix1, iy1, iz1, wx1 * wy1 * wz1);
  }

  // Normalize to [0,1] and apply gamma to emphasize wispy low densities
  let maxVal = 0.0;
  for (let i = 0; i < volume.length; i++) {
    if (volume[i] > maxVal) maxVal = volume[i];
  }
  if (maxVal > 0) {
    const invMax = 1.0 / maxVal;
    for (let i = 0; i < volume.length; i++) {
      const d = volume[i] * invMax;
      volume[i] = Math.pow(d, gamma);
    }
  }

  return {
    data: volume,
    gridSize,
    boundsMin: [-halfExtent, -halfExtent, -halfExtent],
    boundsMax: [ halfExtent,  halfExtent,  halfExtent]
  };
}

// Pack the 3D volume into a 2D atlas texture for WebGL1.
// Layout: gridSize slices in Z, tiled in a slicesPerRow × rows grid.
export function createDensityAtlasTexture(gl, volumeDesc) {
  const { data: volume, gridSize } = volumeDesc;
  const slices = gridSize;
  const slicesPerRow = Math.ceil(Math.sqrt(slices));
  const rows = Math.ceil(slices / slicesPerRow);

  const texWidth = slicesPerRow * gridSize;
  const texHeight = rows * gridSize;

  const texData = new Uint8Array(texWidth * texHeight);

  for (let z = 0; z < gridSize; z++) {
    const sliceIndex = z;
    const col = sliceIndex % slicesPerRow;
    const row = Math.floor(sliceIndex / slicesPerRow);

    const xOffset = col * gridSize;
    const yOffset = row * gridSize;

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const srcIdx = x + gridSize * (y + gridSize * z);
        const dstIdx = (xOffset + x) + texWidth * (yOffset + y);
        const density01 = volume[srcIdx];
        texData[dstIdx] = Math.max(0, Math.min(255, Math.floor(density01 * 255 + 0.5)));
      }
    }
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.LUMINANCE,
    texWidth,
    texHeight,
    0,
    gl.LUMINANCE,
    gl.UNSIGNED_BYTE,
    texData
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const tileUVSize = [
    gridSize / texWidth,
    gridSize / texHeight
  ];

  return {
    texture,
    gridSize,
    slicesPerRow,
    tileUVSize,
    atlasSize: [texWidth, texHeight]
  };
}
