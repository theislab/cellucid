// density-shaders.js - GPU-Accelerated Density Volume Splatting Shaders
// Used for splatting points into a 2D atlas (representing 3D volume)
//
// The published volume is RGBA8:
//   r   = density (summed trilinear weight, normalized to [0,1]);
//   gba = the mean display colour of the cells there, premultiplied by that
//         density, so trilinear filtering and mipmapping average colour by
//         the cells that produced it and the cloud carries the active
//         field's colours.
// Density and colour are accumulated in two passes over the same staged
// batch: density into an R32F atlas with the eight trilinear corners of every
// cell, colour into an RGBA32F atlas with one vertex per cell at its nearest
// voxel. Colour is a mean, which one sample per cell already determines;
// splatting it with eight float4 corners would cost eight times the blending
// bandwidth of density for no visible difference.

// Shared by both splat passes: the soft slab of flat clouds and the atlas
// address of a voxel.
const SPLAT_COMMON = `
// A cloud with no extent along an axis -- every 2D embedding along z, a 1D
// one along y and z, and a 3D one that happens to be planar -- would collapse
// into a voxel-thin sheet that a ray march steps straight over. Along each
// such axis (u_flatAxes = 1) every cell is spread over a soft slab of
// u_slabHalfThickness (world units) around its coordinate instead.
uniform float u_slabHalfThickness;
uniform vec3 u_flatAxes;

uniform float u_gridSize;
uniform float u_atlasWidth;  // gridSize * slicesPerRow
uniform float u_atlasHeight; // gridSize * numRows
uniform float u_slicesPerRow;

// Deterministic per-cell offset in [-1, 1] with a triangular (tent)
// distribution, so a slab has a soft rather than a hard face.
float tentOffset(uint seed) {
  seed ^= seed >> 16u; seed *= 0x7feb352du; seed ^= seed >> 15u; seed *= 0x846ca68bu; seed ^= seed >> 16u;
  float a = float(seed & 0xffffu) / 65535.0;
  float b = float(seed >> 16u) / 65535.0;
  return a - b;
}

// The cell's splat position. Only flat clouds are offset: every other cloud
// is splatted from exactly the attribute value. Both passes key the offset on
// the cell's index in its batch, so they agree on where each cell lands.
vec3 splatPosition(vec3 attributePosition, int cellIndex) {
  vec3 position = attributePosition;
  if (any(greaterThan(u_flatAxes, vec3(0.0)))) {
    uint id = uint(cellIndex) * 2654435761u + 0x9e3779b9u;
    position += u_flatAxes * u_slabHalfThickness * vec3(
      tentOffset(id ^ 0x2c1b3c6du),
      tentOffset(id ^ 0x68e31da4u),
      tentOffset(id)
    );
  }
  return position;
}

// Clip-space position of one voxel's texel in the slice atlas.
vec4 atlasClipPosition(ivec3 iv, float gridSize) {
  // Atlas layout: Z slices arranged in a grid
  int sliceIdx = iv.z;
  int sliceRow = sliceIdx / int(u_slicesPerRow);
  int sliceCol = sliceIdx - sliceRow * int(u_slicesPerRow);

  // Pixel position in atlas
  float px = float(sliceCol) * gridSize + float(iv.x) + 0.5;
  float py = float(sliceRow) * gridSize + float(iv.y) + 0.5;

  // Convert to clip space [-1, 1]
  float clipX = (px / u_atlasWidth) * 2.0 - 1.0;
  float clipY = (py / u_atlasHeight) * 2.0 - 1.0;
  return vec4(clipX, clipY, 0.0, 1.0);
}
`;

// Density pass: eight trilinear corners per cell (one instance per cell).
export const SPLAT_VS = `#version 300 es
precision highp float;

// Per-instance: point position
layout(location = 1) in vec3 a_position;

// Per-vertex: corner offset (0-7 for 8 trilinear corners). Location 0 is the
// per-vertex stream every draw enables, so no browser has to emulate it.
layout(location = 0) in float a_cornerIndex;
${SPLAT_COMMON}
out float v_weight;

void main() {
  float gridSize = u_gridSize;
  float halfExtent = 1.0;
  vec3 position = splatPosition(a_position, gl_InstanceID);

  // Map position from [-1,1] to [0, gridSize-1]
  vec3 fp = (position + halfExtent) / (2.0 * halfExtent) * (gridSize - 1.0);

  // Skip if outside bounds
  if (any(lessThan(position, vec3(-halfExtent))) || any(greaterThan(position, vec3(halfExtent)))) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // off-screen
    v_weight = 0.0;
    return;
  }

  // Base voxel indices
  ivec3 i0 = ivec3(floor(fp));
  i0 = clamp(i0, ivec3(0), ivec3(int(gridSize) - 1));

  // Fractional position within voxel
  vec3 t = fp - vec3(i0);

  // Determine which corner this instance represents (0-7)
  int corner = int(a_cornerIndex);
  int dx = corner & 1;
  int dy = (corner >> 1) & 1;
  int dz = (corner >> 2) & 1;

  // Target voxel
  ivec3 iv = i0 + ivec3(dx, dy, dz);
  iv = clamp(iv, ivec3(0), ivec3(int(gridSize) - 1));

  // Trilinear weight
  float wx = (dx == 0) ? (1.0 - t.x) : t.x;
  float wy = (dy == 0) ? (1.0 - t.y) : t.y;
  float wz = (dz == 0) ? (1.0 - t.z) : t.z;
  v_weight = wx * wy * wz;

  // Skip zero-weight contributions
  if (v_weight < 0.0001) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }

  gl_Position = atlasClipPosition(iv, gridSize);
  gl_PointSize = 1.0;
}
`;

export const SPLAT_FS = `#version 300 es
precision highp float;

in float v_weight;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_weight, 0.0, 0.0, 1.0);
}
`;

// Colour pass: one vertex per cell at its nearest voxel, accumulating
// (rgb, 1) so the normalize pass can divide out the mean colour.
export const SPLAT_COLOR_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
// Per-cell display colour (normalized RGBA8; alpha is not used).
layout(location = 1) in vec4 a_color;
${SPLAT_COMMON}
out vec4 v_color;

void main() {
  float gridSize = u_gridSize;
  vec3 position = splatPosition(a_position, gl_VertexID);
  if (any(lessThan(position, vec3(-1.0))) || any(greaterThan(position, vec3(1.0)))) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    v_color = vec4(0.0);
    return;
  }
  vec3 fp = (position + 1.0) * 0.5 * (gridSize - 1.0);
  ivec3 iv = clamp(ivec3(floor(fp + 0.5)), ivec3(0), ivec3(int(gridSize) - 1));
  v_color = vec4(a_color.rgb, 1.0);
  gl_Position = atlasClipPosition(iv, gridSize);
  gl_PointSize = 1.0;
}
`;

export const SPLAT_COLOR_FS = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

// Shader for normalizing and applying gamma to the atlas
export const NORMALIZE_VS = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Reduces one R32F atlas level to the maximum of each 2x2 texel block.
// Repeating this pass down to 1x1 preserves the exact global maximum without
// synchronizing the GPU back to JavaScript.
export const REDUCE_MAX_FS = `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform ivec2 u_inputSize;

out vec4 fragColor;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 2;
  float maximum = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      ivec2 coord = base + ivec2(x, y);
      if (all(lessThan(coord, u_inputSize))) {
        maximum = max(maximum, texelFetch(u_input, coord, 0).r);
      }
    }
  }
  fragColor = vec4(maximum, 0.0, 0.0, 1.0);
}
`;

export const NORMALIZE_FS = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform sampler2D u_colorAtlas;
uniform sampler2D u_maxAtlas;
uniform float u_gamma;
uniform int u_gridSize;
uniform int u_slicesPerRow;

in vec2 v_uv;
out vec4 fragColor;

ivec2 atlasTexel(ivec3 voxel) {
  int row = voxel.z / u_slicesPerRow;
  int column = voxel.z - row * u_slicesPerRow;
  return ivec2(column * u_gridSize + voxel.x, row * u_gridSize + voxel.y);
}

void main() {
  // texelFetch: the atlases are float32, which only OES_texture_float_linear
  // makes filterable; one texel per fragment needs no filtering at all.
  float density = texelFetch(u_atlas, ivec2(gl_FragCoord.xy), 0).r;
  float maximum = texelFetch(u_maxAtlas, ivec2(0), 0).r;
  float normalized = density / max(maximum, 0.0001);
  float result = pow(clamp(normalized, 0.0, 1.0), u_gamma);
  float quantized = floor(result * 255.0 + 0.5) / 255.0;

  // Mean display colour of the cells nearest this voxel. A voxel that holds
  // trilinear density from a neighbouring cell but is nobody's nearest voxel
  // takes the mean over its 3x3x3 neighbourhood, which always contains the
  // nearest voxel of every cell that reaches it.
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 colorSum = texelFetch(u_colorAtlas, texel, 0);
  if (quantized > 0.0 && colorSum.a == 0.0) {
    ivec3 voxel = ivec3(
      texel.x % u_gridSize,
      texel.y % u_gridSize,
      (texel.y / u_gridSize) * u_slicesPerRow + texel.x / u_gridSize
    );
    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          ivec3 neighbour = voxel + ivec3(x, y, z);
          if (any(lessThan(neighbour, ivec3(0))) || any(greaterThanEqual(neighbour, ivec3(u_gridSize)))) continue;
          colorSum += texelFetch(u_colorAtlas, atlasTexel(neighbour), 0);
        }
      }
    }
  }
  vec3 meanColor = colorSum.a > 0.0 ? clamp(colorSum.rgb / colorSum.a, 0.0, 1.0) : vec3(0.5);
  fragColor = vec4(quantized, meanColor * quantized);
}
`;

// Lighting volume: one layer of a coarse 3D texture per draw.
//
// For every lighting voxel this integrates the density (in density x world
// units) along two kinds of path, once per density build, instead of once per
// ray-march sample every frame:
//   r = optical depth towards the key light, i.e. its shadow;
//   g = mean optical depth over a fixed hemisphere of sky directions, the
//       ambient occlusion that keeps the inside of a dense cluster darker than
//       its rim.
// The ray march scales both by the live density and absorption, so moving
// those sliders never rebuilds this volume.
export const LIGHT_VOLUME_FS = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler3D u_density;
uniform float u_gridSize;
uniform float u_lightGridSize;
uniform float u_layer;
uniform vec3 u_lightDir;

out vec4 fragColor;

const int KEY_STEPS = 48;
const int SKY_STEPS = 12;

float densityAt(vec3 world) {
  vec3 p01 = world * 0.5 + 0.5;
  if (any(lessThan(p01, vec3(0.0))) || any(greaterThan(p01, vec3(1.0)))) return 0.0;
  float grid = max(u_gridSize, 1.0);
  return textureLod(u_density, (p01 * (grid - 1.0) + 0.5) / grid, 1.0).r;
}

// Distance from inside the [-1,1] box to its boundary along dir.
float exitDistance(vec3 origin, vec3 dir) {
  float distance = 1e9;
  for (int axis = 0; axis < 3; axis++) {
    if (abs(dir[axis]) > 1e-5) {
      float bound = dir[axis] > 0.0 ? 1.0 : -1.0;
      distance = min(distance, (bound - origin[axis]) / dir[axis]);
    }
  }
  return max(distance, 0.0);
}

float opticalDepth(vec3 origin, vec3 dir, int steps, float maxDistance) {
  float distance = min(exitDistance(origin, dir), maxDistance);
  if (distance <= 0.0) return 0.0;
  float stepLength = distance / float(steps);
  float depth = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= steps) break;
    depth += densityAt(origin + dir * ((float(i) + 0.5) * stepLength));
  }
  return depth * stepLength;
}

void main() {
  vec3 p01 = vec3(gl_FragCoord.xy / u_lightGridSize, u_layer);
  vec3 world = p01 * 2.0 - 1.0;
  float key = opticalDepth(world, normalize(u_lightDir), KEY_STEPS, 4.0);

  // Upper hemisphere around +Y with the key light leaning in: the sky is
  // brightest from above, as it is for every lit object the eye knows.
  const vec3 SKY[6] = vec3[6](
    vec3(0.0, 1.0, 0.0),
    vec3(0.62, 0.78, 0.0),
    vec3(-0.62, 0.78, 0.0),
    vec3(0.0, 0.78, 0.62),
    vec3(0.0, 0.78, -0.62),
    vec3(0.0, -1.0, 0.0)
  );
  float sky = 0.0;
  for (int i = 0; i < 6; i++) {
    sky += opticalDepth(world, SKY[i], SKY_STEPS, 0.6);
  }
  fragColor = vec4(key, sky / 6.0, 0.0, 1.0);
}
`;

// Occupancy volume for empty-space skipping: one texel per 4x4x4 block of
// density voxels, holding the maximum density of every voxel a trilinear
// density sample anywhere inside the block can read (the block and the next
// voxel along each axis). Zero therefore proves the whole block empty, and the
// ray march may leap to the block's far face in one step.
export const OCCUPANCY_BLOCK = 4;

export const OCCUPANCY_FS = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler3D u_density;
uniform int u_gridSize;
uniform int u_layer;

out vec4 fragColor;

void main() {
  ivec3 block = ivec3(ivec2(gl_FragCoord.xy), u_layer) * ${OCCUPANCY_BLOCK};
  float maximum = 0.0;
  for (int z = 0; z <= ${OCCUPANCY_BLOCK}; z++) {
    for (int y = 0; y <= ${OCCUPANCY_BLOCK}; y++) {
      for (int x = 0; x <= ${OCCUPANCY_BLOCK}; x++) {
        ivec3 voxel = min(block + ivec3(x, y, z), ivec3(u_gridSize - 1));
        maximum = max(maximum, texelFetch(u_density, voxel, 0).r);
      }
    }
  }
  fragColor = vec4(maximum, 0.0, 0.0, 1.0);
}
`;
