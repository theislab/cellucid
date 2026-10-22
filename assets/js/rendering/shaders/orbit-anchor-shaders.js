// orbit-anchor-shaders.js - Precision Scientific Compass Shaders

import { FOG_GLSL } from './fog-shaders.js';

// One lit, fogged mesh program draws both the 3D and the flat 2D compass.
// The mesh is built once in anchor-local units (center at the origin, unit
// radius); u_partMatrix places, scales and turns each part of it every frame.

export const ORBIT_ANCHOR_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec4 a_color;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform mat4 u_partMatrix;
uniform vec3 u_cameraPos;
${FOG_GLSL}
out vec4 v_color;
out vec3 v_normal;
out vec3 v_worldPos;
// The opacity the shared fog model leaves this vertex (fog-shaders.js).
out float v_fogOpacity;

void main() {
  // The part matrix is a rotation about Y times a positive uniform scale, so
  // its upper 3x3 carries normals correctly once renormalized.
  vec4 anchorPos = u_partMatrix * vec4(a_position, 1.0);
  vec4 worldPos = u_modelMatrix * anchorPos;
  v_worldPos = worldPos.xyz;
  vec4 eyePos = u_viewMatrix * worldPos;
  v_fogOpacity = fogOpacity(fogTransmittance(length(eyePos.xyz)));
  gl_Position = u_mvpMatrix * anchorPos;
  v_color = a_color;
  v_normal = normalize(mat3(u_modelMatrix) * (mat3(u_partMatrix) * a_normal));
}
`;

export const ORBIT_ANCHOR_FS = `#version 300 es
precision highp float;

in vec4 v_color;
in vec3 v_normal;
in vec3 v_worldPos;
in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_cameraPos;
uniform float u_emissive;

out vec4 fragColor;

void main() {
  if (v_color.a < 0.01) discard;

  vec3 N = normalize(v_normal);
  vec3 L = normalize(u_lightDir);
  vec3 V = normalize(u_cameraPos - v_worldPos);
  vec3 H = normalize(L + V);

  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);

  // Metallic instrument lighting
  float ambient = 0.30;
  float diffuse = 0.50 * NdotL;
  float specular = pow(NdotH, 80.0) * 0.35;
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.5) * 0.20;

  float lighting = mix(1.0, ambient + diffuse + specular + fresnel, u_lightingStrength);
  vec3 litColor = v_color.rgb * lighting + v_color.rgb * u_emissive * 0.5;

  // Fog thins the anchor toward whatever is behind it (fog-shaders.js).
  fragColor = vec4(litColor, v_color.a * v_fogOpacity);
}
`;
