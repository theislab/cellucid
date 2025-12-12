// centroid-shaders.js - Simple centroid point rendering shaders
// Used for small number of centroid points (WebGL2)
// Uses RGBA uint8 normalized colors (same as main points)

export const CENTROID_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color; // RGBA packed as uint8, auto-normalized by WebGL

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform float u_pointSize;
uniform float u_sizeAttenuation;
uniform float u_viewportHeight;
uniform float u_fov;

out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);

  // Compute eye-space depth for perspective scaling (matches HP_VS_FULL)
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  vec4 eyePos = u_viewMatrix * worldPos;
  float eyeDepth = -eyePos.z;

  // Perspective point size with attenuation
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 0.5, 128.0);

  if (a_color.a < 0.01) gl_PointSize = 0.0;
  v_color = a_color.rgb;
  v_alpha = a_color.a;
}
`;

export const CENTROID_FS = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_alpha;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  if (r2 > 1.0) discard;

  // Simple sphere shading
  float z = sqrt(1.0 - r2);
  vec3 normal = vec3(coord.x, -coord.y, z);
  vec3 lightDir = normalize(vec3(0.5, 0.7, 0.5));
  float NdotL = max(dot(normal, lightDir), 0.0);
  float lighting = 0.4 + 0.6 * NdotL;

  fragColor = vec4(v_color * lighting, v_alpha);
}
`;
