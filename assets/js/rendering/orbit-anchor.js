// orbit-anchor.js - Precision Scientific Compass
// Compact, elegant design inspired by marine navigation instruments and gyrocompasses
// Features:
// - Slim gimbal rings with fine graduations
// - Classic compass needle with luminous north marker
// - Precision elevation clinometer
// - Per-view independent state for unlocked camera mode

import {
  ORBIT_ANCHOR_3D_VS,
  ORBIT_ANCHOR_3D_FS,
  ORBIT_ANCHOR_2D_VS,
  ORBIT_ANCHOR_2D_FS
} from './shaders/orbit-anchor-shaders.js';

// === ORBIT ANCHOR RENDERER CLASS ===

export class OrbitAnchorRenderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;

    // Per-view state
    this.viewStates = new Map();

    // Global settings
    this.showAnchor = true;

    // Compile shaders and create programs
    this.program3D = this._createProgram(ORBIT_ANCHOR_3D_VS, ORBIT_ANCHOR_3D_FS);
    this.program2D = this._createProgram(ORBIT_ANCHOR_2D_VS, ORBIT_ANCHOR_2D_FS);

    // Get attribute and uniform locations
    this._setupLocations();
  }

  dispose() {
    const gl = this.gl;

    for (const viewId of Array.from(this.viewStates.keys())) {
      this.deleteViewState(viewId);
    }
    this.viewStates.clear();

    if (this.program3D) gl.deleteProgram(this.program3D);
    if (this.program2D) gl.deleteProgram(this.program2D);
    this.program3D = null;
    this.program2D = null;
  }

  _createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Orbit anchor shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._createShader(gl.VERTEX_SHADER, vsSource);
    const fs = this._createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Orbit anchor program link error:', gl.getProgramInfoLog(program));
      return null;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  _setupLocations() {
    const gl = this.gl;

    // 3D program locations
    this.attribs3D = {
      position: gl.getAttribLocation(this.program3D, 'a_position'),
      normal: gl.getAttribLocation(this.program3D, 'a_normal'),
      color: gl.getAttribLocation(this.program3D, 'a_color'),
    };
    this.uniforms3D = {
      mvpMatrix: gl.getUniformLocation(this.program3D, 'u_mvpMatrix'),
      viewMatrix: gl.getUniformLocation(this.program3D, 'u_viewMatrix'),
      modelMatrix: gl.getUniformLocation(this.program3D, 'u_modelMatrix'),
      cameraPos: gl.getUniformLocation(this.program3D, 'u_cameraPos'),
      fogDensity: gl.getUniformLocation(this.program3D, 'u_fogDensity'),
      fogNear: gl.getUniformLocation(this.program3D, 'u_fogNear'),
      fogFar: gl.getUniformLocation(this.program3D, 'u_fogFar'),
      fogColor: gl.getUniformLocation(this.program3D, 'u_fogColor'),
      lightingStrength: gl.getUniformLocation(this.program3D, 'u_lightingStrength'),
      lightDir: gl.getUniformLocation(this.program3D, 'u_lightDir'),
      emissive: gl.getUniformLocation(this.program3D, 'u_emissive'),
    };

    // 2D program locations
    this.attribs2D = {
      position: gl.getAttribLocation(this.program2D, 'a_position'),
      color: gl.getAttribLocation(this.program2D, 'a_color'),
    };
    this.uniforms2D = {
      mvpMatrix: gl.getUniformLocation(this.program2D, 'u_mvpMatrix'),
      viewMatrix: gl.getUniformLocation(this.program2D, 'u_viewMatrix'),
      fogDensity: gl.getUniformLocation(this.program2D, 'u_fogDensity'),
      fogNear: gl.getUniformLocation(this.program2D, 'u_fogNear'),
      fogFar: gl.getUniformLocation(this.program2D, 'u_fogFar'),
      fogColor: gl.getUniformLocation(this.program2D, 'u_fogColor'),
    };
  }

  // Get or create per-view state
  getViewState(viewId) {
    if (!this.viewStates.has(viewId)) {
      const gl = this.gl;
      this.viewStates.set(viewId, {
        positionBuffer: gl.createBuffer(),
        normalBuffer: gl.createBuffer(),
        colorBuffer: gl.createBuffer(),
        indexBuffer: gl.createBuffer(),
        linePositionBuffer: gl.createBuffer(),
        lineNormalBuffer: gl.createBuffer(),
        lineColorBuffer: gl.createBuffer(),
        vertexCount: 0,
        indexCount: 0,
        lineCount: 0,
        lineData: null,
        needsRebuild: true,
        is3D: true,
        lastX: NaN, lastY: NaN, lastZ: NaN,
        lastRadius: NaN,
        lastTheta: NaN, lastPhi: NaN,
        lastBgLuminance: -1
      });
    }
    return this.viewStates.get(viewId);
  }

  // Clean up view state
  deleteViewState(viewId) {
    const gl = this.gl;
    const state = this.viewStates.get(viewId);
    if (state) {
      gl.deleteBuffer(state.positionBuffer);
      gl.deleteBuffer(state.normalBuffer);
      gl.deleteBuffer(state.colorBuffer);
      gl.deleteBuffer(state.indexBuffer);
      gl.deleteBuffer(state.linePositionBuffer);
      gl.deleteBuffer(state.lineNormalBuffer);
      gl.deleteBuffer(state.lineColorBuffer);
      this.viewStates.delete(viewId);
    }
  }

  // Trigger rebuild for all views
  markAllNeedsRebuild() {
    for (const state of this.viewStates.values()) {
      state.needsRebuild = true;
    }
  }

  // Professional scientific instrument color palette
  getColors(bgColor) {
    const luminance = bgColor[0] * 0.299 + bgColor[1] * 0.587 + bgColor[2] * 0.114;
    const isDark = luminance < 0.5;

    if (isDark) {
      return {
        // Brushed brass/bronze bezel - classic instrument
        bezel: [0.72, 0.58, 0.38, 0.92],
        bezelHighlight: [0.82, 0.68, 0.48, 0.95],
        bezelShadow: [0.55, 0.42, 0.28, 0.88],
        // Inner dial - ivory/cream like vintage instruments
        dial: [0.92, 0.90, 0.85, 0.15],
        // Graduation marks - bright and visible on dark backgrounds
        tickFine: [0.72, 0.74, 0.78, 0.65],
        tickMajor: [0.82, 0.84, 0.88, 0.85],
        tickCardinal: [0.92, 0.94, 0.96, 0.95],
        // North marker - classic red
        north: [0.92, 0.20, 0.15, 1.0],
        northGlow: [1.0, 0.30, 0.25, 0.60],
        // Compass needle - blued steel
        needleNorth: [0.92, 0.20, 0.15, 1.0],
        needleSouth: [0.22, 0.28, 0.42, 0.95],
        needleCenter: [0.70, 0.72, 0.75, 1.0],
        // Gimbal ring - polished steel
        gimbal: [0.78, 0.80, 0.84, 0.85],
        gimbalDark: [0.55, 0.58, 0.62, 0.80],
        // Elevation arc - matches gimbal ring
        arc: [0.78, 0.80, 0.84, 0.85],
        arcTick: [0.72, 0.74, 0.78, 0.80],
        // Elevation indicator - luminous
        elevMarker: [0.95, 0.85, 0.30, 1.0],
        elevGlow: [1.0, 0.92, 0.50, 0.45],
      };
    } else {
      return {
        // Darker brass for light backgrounds
        bezel: [0.50, 0.40, 0.25, 0.90],
        bezelHighlight: [0.62, 0.50, 0.32, 0.92],
        bezelShadow: [0.38, 0.30, 0.18, 0.85],
        // Inner dial
        dial: [0.15, 0.15, 0.18, 0.08],
        // Graduation marks
        tickFine: [0.35, 0.35, 0.38, 0.50],
        tickMajor: [0.22, 0.22, 0.25, 0.75],
        tickCardinal: [0.12, 0.12, 0.15, 0.90],
        // North marker
        north: [0.78, 0.12, 0.10, 1.0],
        northGlow: [0.90, 0.25, 0.20, 0.50],
        // Compass needle
        needleNorth: [0.78, 0.12, 0.10, 1.0],
        needleSouth: [0.25, 0.28, 0.40, 0.92],
        needleCenter: [0.45, 0.48, 0.52, 1.0],
        // Gimbal ring
        gimbal: [0.45, 0.48, 0.52, 0.82],
        gimbalDark: [0.32, 0.35, 0.40, 0.78],
        // Elevation arc - matches gimbal ring
        arc: [0.45, 0.48, 0.52, 0.82],
        arcTick: [0.35, 0.38, 0.42, 0.75],
        // Elevation indicator
        elevMarker: [0.85, 0.65, 0.15, 1.0],
        elevGlow: [0.92, 0.75, 0.25, 0.40],
      };
    }
  }

  // Compact anchor radius - precision instrument scale
  computeAnchorRadius(pointBoundsRadius) {
    const base = (pointBoundsRadius || 1.0);
    return base * 0.018;  // Very compact, precise size
  }

  // === 3D GEOMETRY BUILDERS ===

  // Smooth sphere (icosphere)
  _generateSphere(cx, cy, cz, radius, subdivisions, color) {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];

    const t = (1.0 + Math.sqrt(5.0)) / 2.0;
    const icoVerts = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ].map(v => {
      const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      return [v[0] / len, v[1] / len, v[2] / len];
    });

    const icoFaces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
    ];

    const midPointCache = {};
    function getMidPoint(p1Idx, p2Idx, verts) {
      const key = p1Idx < p2Idx ? `${p1Idx}_${p2Idx}` : `${p2Idx}_${p1Idx}`;
      if (midPointCache[key] !== undefined) return midPointCache[key];
      const p1 = verts[p1Idx], p2 = verts[p2Idx];
      const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
      const len = Math.sqrt(mid[0] * mid[0] + mid[1] * mid[1] + mid[2] * mid[2]);
      mid[0] /= len; mid[1] /= len; mid[2] /= len;
      const newIdx = verts.length;
      verts.push(mid);
      midPointCache[key] = newIdx;
      return newIdx;
    }

    let verts = [...icoVerts];
    let faces = [...icoFaces];
    for (let s = 0; s < subdivisions; s++) {
      const newFaces = [];
      for (const face of faces) {
        const a = getMidPoint(face[0], face[1], verts);
        const b = getMidPoint(face[1], face[2], verts);
        const c = getMidPoint(face[2], face[0], verts);
        newFaces.push([face[0], a, c], [face[1], b, a], [face[2], c, b], [a, b, c]);
      }
      faces = newFaces;
    }

    for (const v of verts) {
      positions.push(cx + v[0] * radius, cy + v[1] * radius, cz + v[2] * radius);
      normals.push(v[0], v[1], v[2]);
      colors.push(color[0], color[1], color[2], color[3]);
    }
    for (const face of faces) indices.push(face[0], face[1], face[2]);

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Beveled torus for bezel ring
  _generateBeveledTorus(cx, cy, cz, majorRadius, minorRadius, majorSegs, minorSegs, innerColor, outerColor, axis = 'y') {
    const positions = [], normals = [], colors = [], indices = [];

    for (let i = 0; i <= majorSegs; i++) {
      const u = (i / majorSegs) * Math.PI * 2;
      const cosU = Math.cos(u), sinU = Math.sin(u);

      for (let j = 0; j <= minorSegs; j++) {
        const v = (j / minorSegs) * Math.PI * 2;
        const cosV = Math.cos(v), sinV = Math.sin(v);

        // Blend colors based on position on minor circle
        const blend = (Math.sin(v) + 1.0) * 0.5;
        const color = [
          innerColor[0] * (1 - blend) + outerColor[0] * blend,
          innerColor[1] * (1 - blend) + outerColor[1] * blend,
          innerColor[2] * (1 - blend) + outerColor[2] * blend,
          innerColor[3] * (1 - blend) + outerColor[3] * blend,
        ];

        const tubeRadius = majorRadius + minorRadius * cosV;

        let px, py, pz, nx, ny, nz;
        if (axis === 'y') {
          px = tubeRadius * cosU; py = minorRadius * sinV; pz = tubeRadius * sinU;
          nx = cosV * cosU; ny = sinV; nz = cosV * sinU;
        } else if (axis === 'x') {
          py = tubeRadius * cosU; pz = tubeRadius * sinU; px = minorRadius * sinV;
          ny = cosV * cosU; nz = cosV * sinU; nx = sinV;
        } else {
          px = tubeRadius * cosU; pz = minorRadius * sinV; py = tubeRadius * sinU;
          nx = cosV * cosU; nz = sinV; ny = cosV * sinU;
        }

        positions.push(cx + px, cy + py, cz + pz);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
    }

    for (let i = 0; i < majorSegs; i++) {
      for (let j = 0; j < minorSegs; j++) {
        const a = i * (minorSegs + 1) + j;
        const b = a + minorSegs + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Simple torus
  _generateTorus(cx, cy, cz, majorRadius, minorRadius, majorSegs, minorSegs, color, axis = 'y', startAngle = 0, endAngle = Math.PI * 2) {
    const positions = [], normals = [], colors = [], indices = [];
    const angleRange = endAngle - startAngle;

    for (let i = 0; i <= majorSegs; i++) {
      const u = startAngle + (i / majorSegs) * angleRange;
      const cosU = Math.cos(u), sinU = Math.sin(u);

      for (let j = 0; j <= minorSegs; j++) {
        const v = (j / minorSegs) * Math.PI * 2;
        const cosV = Math.cos(v), sinV = Math.sin(v);
        const tubeRadius = majorRadius + minorRadius * cosV;

        let px, py, pz, nx, ny, nz;
        if (axis === 'y') {
          px = tubeRadius * cosU; py = minorRadius * sinV; pz = tubeRadius * sinU;
          nx = cosV * cosU; ny = sinV; nz = cosV * sinU;
        } else if (axis === 'x') {
          py = tubeRadius * cosU; pz = tubeRadius * sinU; px = minorRadius * sinV;
          ny = cosV * cosU; nz = cosV * sinU; nx = sinV;
        } else {
          px = tubeRadius * cosU; pz = minorRadius * sinV; py = tubeRadius * sinU;
          nx = cosV * cosU; nz = sinV; ny = cosV * sinU;
        }

        positions.push(cx + px, cy + py, cz + pz);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
    }

    for (let i = 0; i < majorSegs; i++) {
      for (let j = 0; j < minorSegs; j++) {
        const a = i * (minorSegs + 1) + j;
        const b = a + minorSegs + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Cylinder for tick marks and needle
  _generateCylinder(x1, y1, z1, x2, y2, z2, radius, segments, color) {
    const positions = [], normals = [], colors = [], indices = [];
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.0001) return { positions: [], normals: [], colors: [], indices: [], vertexCount: 0 };

    const ax = dx / len, ay = dy / len, az = dz / len;
    let px, py, pz;
    if (Math.abs(ay) < 0.9) { px = -az; py = 0; pz = ax; }
    else { px = 1; py = 0; pz = 0; }
    const pLen = Math.sqrt(px * px + py * py + pz * pz);
    px /= pLen; py /= pLen; pz /= pLen;
    const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;

    for (let cap = 0; cap < 2; cap++) {
      const bx = cap === 0 ? x1 : x2, by = cap === 0 ? y1 : y2, bz = cap === 0 ? z1 : z2;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const c = Math.cos(angle), s = Math.sin(angle);
        const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
        positions.push(bx + nx * radius, by + ny * radius, bz + nz * radius);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
    }

    for (let i = 0; i < segments; i++) {
      indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2);
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Tapered cylinder for needle
  _generateTaperedCylinder(x1, y1, z1, x2, y2, z2, radius1, radius2, segments, color) {
    const positions = [], normals = [], colors = [], indices = [];
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.0001) return { positions: [], normals: [], colors: [], indices: [], vertexCount: 0 };

    const ax = dx / len, ay = dy / len, az = dz / len;
    let px, py, pz;
    if (Math.abs(ay) < 0.9) { px = -az; py = 0; pz = ax; }
    else { px = 1; py = 0; pz = 0; }
    const pLen = Math.sqrt(px * px + py * py + pz * pz);
    px /= pLen; py /= pLen; pz /= pLen;
    const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;

    // First cap (larger radius)
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
      positions.push(x1 + nx * radius1, y1 + ny * radius1, z1 + nz * radius1);
      normals.push(nx, ny, nz);
      colors.push(color[0], color[1], color[2], color[3]);
    }

    // Second cap (smaller radius)
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
      positions.push(x2 + nx * radius2, y2 + ny * radius2, z2 + nz * radius2);
      normals.push(nx, ny, nz);
      colors.push(color[0], color[1], color[2], color[3]);
    }

    for (let i = 0; i < segments; i++) {
      indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2);
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Diamond tip for needle
  _generateDiamondTip(cx, cy, cz, length, width, height, color, rotationY = 0) {
    const positions = [], normals = [], colors = [], indices = [];
    const cosR = Math.cos(rotationY), sinR = Math.sin(rotationY);

    const verts = [
      [length, 0, 0],           // tip
      [-length * 0.2, 0, 0],    // back
      [0, 0, width],            // left
      [0, 0, -width],           // right
      [0, height, 0],           // top
      [0, -height, 0],          // bottom
    ];

    const transformed = verts.map(v => [
      cx + v[0] * cosR - v[2] * sinR,
      cy + v[1],
      cz + v[0] * sinR + v[2] * cosR
    ]);

    const faces = [
      [0, 4, 2], [0, 3, 4], [0, 2, 5], [0, 5, 3],
      [1, 2, 4], [1, 4, 3], [1, 5, 2], [1, 3, 5],
    ];

    for (const face of faces) {
      const v0 = transformed[face[0]], v1 = transformed[face[1]], v2 = transformed[face[2]];
      const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
      const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1];
      let ny = e1[2] * e2[0] - e1[0] * e2[2];
      let nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen > 0) { nx /= nLen; ny /= nLen; nz /= nLen; }

      const baseIdx = positions.length / 3;
      for (const idx of face) {
        positions.push(transformed[idx][0], transformed[idx][1], transformed[idx][2]);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Build 3D compass geometry - Precision scientific instrument
  buildGeometry3D(cx, cy, cz, r, viewTheta, viewPhi, bgColor) {
    const palette = this.getColors(bgColor);

    let allPositions = [], allNormals = [], allColors = [], allIndices = [];
    let linePositions = [], lineNormals = [], lineColors = [];

    const mergeGeometry = (geom) => {
      if (!geom || geom.positions.length === 0) return;
      const baseIdx = allPositions.length / 3;
      allPositions.push(...geom.positions);
      allNormals.push(...geom.normals);
      allColors.push(...geom.colors);
      for (const idx of geom.indices) allIndices.push(baseIdx + idx);
    };

    const addLine = (x1, y1, z1, x2, y2, z2, color, normal) => {
      linePositions.push(x1, y1, z1, x2, y2, z2);
      lineNormals.push(...normal, ...normal);
      lineColors.push(...color, ...color);
    };

    // === OUTER BEZEL RING - Beveled brass/bronze ===
    const bezelRadius = r * 0.82;
    const bezelThickness = r * 0.045;
    const bezel = this._generateBeveledTorus(cx, cy, cz, bezelRadius, bezelThickness, 64, 12, palette.bezelShadow, palette.bezelHighlight, 'y');
    mergeGeometry(bezel);

    // === INNER DIAL RING - thin chapter ring (moved inward for tick room) ===
    const dialRadius = bezelRadius * 0.78;
    const dialThickness = r * 0.016;
    const dialRing = this._generateTorus(cx, cy, cz, dialRadius, dialThickness, 56, 8, palette.gimbal, 'y');
    mergeGeometry(dialRing);

    // === CENTER PIVOT - polished steel jewel mount ===
    const pivotSphere = this._generateSphere(cx, cy, cz, r * 0.09, 2, palette.needleCenter);
    mergeGeometry(pivotSphere);

    // === GRADUATION MARKS ===
    // Fine ticks every 5°, major every 15°, cardinal every 90°
    for (let deg = 0; deg < 360; deg += 5) {
      const angle = deg * Math.PI / 180;
      const isCardinal = deg % 90 === 0;
      const isMajor = deg % 15 === 0;

      let tickInner, tickOuter, tickRadius, tickColor;

      if (isCardinal) {
        tickInner = dialRadius * 1.03;
        tickOuter = bezelRadius * 0.94;
        tickRadius = r * 0.011;
        tickColor = deg === 0 ? palette.north : palette.tickCardinal;
      } else if (isMajor) {
        tickInner = dialRadius * 1.06;
        tickOuter = bezelRadius * 0.92;
        tickRadius = r * 0.007;
        tickColor = palette.tickMajor;
      } else {
        tickInner = dialRadius * 1.07;
        tickOuter = bezelRadius * 0.90;
        tickRadius = r * 0.0045;
        tickColor = palette.tickFine;
      }

      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const tick = this._generateCylinder(
        cx + cosA * tickInner, cy, cz + sinA * tickInner,
        cx + cosA * tickOuter, cy, cz + sinA * tickOuter,
        tickRadius, 6, tickColor
      );
      mergeGeometry(tick);
    }

    // === NORTH MARKER - luminous triangle ===
    const northDist = bezelRadius + r * 0.065;
    const northTip = this._generateDiamondTip(
      cx + northDist, cy + r * 0.025, cz,
      r * 0.065, r * 0.04, r * 0.02,
      palette.north, 0
    );
    mergeGeometry(northTip);

    // North glow
    const northGlow = this._generateSphere(cx + northDist, cy + r * 0.025, cz, r * 0.032, 1, palette.northGlow);
    mergeGeometry(northGlow);

    // === COMPASS NEEDLE - classic two-tone design ===
    const needleAngle = viewTheta + Math.PI;
    const needleLen = dialRadius * 0.90;
    const needleStart = r * 0.12;
    const needleHeight = r * 0.032;

    // North half (red) - tapered
    const cosN = Math.cos(needleAngle), sinN = Math.sin(needleAngle);
    const northNeedle = this._generateTaperedCylinder(
      cx + cosN * needleStart, cy + needleHeight, cz + sinN * needleStart,
      cx + cosN * needleLen, cy + needleHeight, cz + sinN * needleLen,
      r * 0.016, r * 0.005, 8, palette.needleNorth
    );
    mergeGeometry(northNeedle);

    // North tip
    const northNeedleTip = this._generateDiamondTip(
      cx + cosN * needleLen, cy + needleHeight, cz + sinN * needleLen,
      r * 0.045, r * 0.02, r * 0.013,
      palette.needleNorth, needleAngle
    );
    mergeGeometry(northNeedleTip);

    // South half (blued steel) - tapered opposite direction
    const southAngle = needleAngle + Math.PI;
    const cosS = Math.cos(southAngle), sinS = Math.sin(southAngle);
    const southNeedle = this._generateTaperedCylinder(
      cx + cosS * needleStart, cy + needleHeight, cz + sinS * needleStart,
      cx + cosS * needleLen * 0.60, cy + needleHeight, cz + sinS * needleLen * 0.60,
      r * 0.016, r * 0.008, 8, palette.needleSouth
    );
    mergeGeometry(southNeedle);

    // South tail
    const southTail = this._generateDiamondTip(
      cx + cosS * needleLen * 0.60, cy + needleHeight, cz + sinS * needleLen * 0.60,
      r * 0.032, r * 0.016, r * 0.010,
      palette.needleSouth, southAngle
    );
    mergeGeometry(southTail);

    // === GIMBAL/CLINOMETER RING - elevation arc (matches inner dial) ===
    const arcRadius = dialRadius * 0.68;
    const arcThickness = dialThickness;  // Match inner dial thickness
    const arcSegs = 36;

    // Create vertical arc facing north (fixed orientation for stability)
    for (let i = 0; i < arcSegs; i++) {
      const el1 = -Math.PI * 0.5 + (i / arcSegs) * Math.PI;
      const el2 = -Math.PI * 0.5 + ((i + 1) / arcSegs) * Math.PI;

      const x1 = arcRadius * Math.cos(el1), y1 = arcRadius * Math.sin(el1);
      const x2 = arcRadius * Math.cos(el2), y2 = arcRadius * Math.sin(el2);

      const arcSeg = this._generateCylinder(
        cx + x1, cy + y1, cz,
        cx + x2, cy + y2, cz,
        arcThickness, 6, palette.arc
      );
      mergeGeometry(arcSeg);
    }

    // Clinometer graduation
    for (const deg of [-90, -60, -30, 0, 30, 60, 90]) {
      const elRad = deg * Math.PI / 180;
      const isMajor = deg === 0 || Math.abs(deg) === 90;

      const arcX = arcRadius * Math.cos(elRad);
      const arcY = arcRadius * Math.sin(elRad);

      const tickLen = isMajor ? r * 0.035 : r * 0.020;
      const tickRadius = isMajor ? r * 0.007 : r * 0.004;
      const outX = (arcRadius + tickLen) * Math.cos(elRad);
      const outY = (arcRadius + tickLen) * Math.sin(elRad);

      const tick = this._generateCylinder(
        cx + arcX, cy + arcY, cz,
        cx + outX, cy + outY, cz,
        tickRadius, 5, palette.arcTick
      );
      mergeGeometry(tick);
    }

    // === ELEVATION INDICATOR - luminous marker ===
    const adjustedPhi = viewPhi - Math.PI * 0.5;
    const clampedEl = Math.max(-Math.PI * 0.5, Math.min(Math.PI * 0.5, adjustedPhi));

    const elX = arcRadius * Math.cos(clampedEl);
    const elY = arcRadius * Math.sin(clampedEl);

    const elevSphere = this._generateSphere(cx + elX, cy + elY, cz, r * 0.040, 2, palette.elevMarker);
    mergeGeometry(elevSphere);

    const elevGlow = this._generateTorus(cx + elX, cy + elY, cz, r * 0.052, r * 0.008, 12, 6, palette.elevGlow, 'z');
    mergeGeometry(elevGlow);

    // === FINE CROSSHAIR at center ===
    const crossLen = dialRadius * 0.55;
    const crossColor = [palette.tickFine[0], palette.tickFine[1], palette.tickFine[2], 0.40];
    addLine(cx - crossLen, cy, cz, cx + crossLen, cy, cz, crossColor, [0, 1, 0]);
    addLine(cx, cy, cz - crossLen, cx, cy, cz + crossLen, crossColor, [0, 1, 0]);

    return {
      positions: new Float32Array(allPositions),
      normals: new Float32Array(allNormals),
      colors: new Float32Array(allColors),
      indices: new Uint16Array(allIndices),
      indexCount: allIndices.length,
      vertexCount: allPositions.length / 3,
      linePositions: new Float32Array(linePositions),
      lineNormals: new Float32Array(lineNormals),
      lineColors: new Float32Array(lineColors),
      lineCount: linePositions.length / 3
    };
  }

  // Build 2D compass geometry - Clean, minimal design for light/ultralight shaders
  buildGeometry2D(cx, cy, cz, r, viewTheta, viewPhi, bgColor) {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    const palette = this.getColors(bgColor);

    const addVertex = (x, y, z, color) => {
      const idx = positions.length / 3;
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      colors.push(color[0], color[1], color[2], color[3]);
      return idx;
    };

    const addTriangle = (i1, i2, i3) => {
      indices.push(i1, i2, i3);
    };

    // Thick line as flat quad
    const addThickLine = (x1, y1, z1, x2, y2, z2, color, width) => {
      const dx = x2 - x1, dz = z2 - z1;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.0001) return;

      const px = -dz / len * width;
      const pz = dx / len * width;

      const i1 = addVertex(x1 + px, y1, z1 + pz, color);
      const i2 = addVertex(x1 - px, y1, z1 - pz, color);
      const i3 = addVertex(x2 + px, y2, z2 + pz, color);
      const i4 = addVertex(x2 - px, y2, z2 - pz, color);

      addTriangle(i1, i2, i3);
      addTriangle(i2, i4, i3);
    };

    // 3D thick line for elevation arc
    const addThickLine3D = (x1, y1, z1, x2, y2, z2, color, width) => {
      const dx = x2 - x1, dz = z2 - z1;
      const lenXZ = Math.sqrt(dx * dx + dz * dz);
      if (lenXZ < 0.0001) return;

      const px = -dz / lenXZ * width;
      const pz = dx / lenXZ * width;

      const i1 = addVertex(x1 + px, y1, z1 + pz, color);
      const i2 = addVertex(x1 - px, y1, z1 - pz, color);
      const i3 = addVertex(x2 + px, y2, z2 + pz, color);
      const i4 = addVertex(x2 - px, y2, z2 - pz, color);

      addTriangle(i1, i2, i3);
      addTriangle(i2, i4, i3);
    };

    // Filled disc
    const addDisc = (ccx, ccy, ccz, radius, segments, color) => {
      const centerIdx = addVertex(ccx, ccy, ccz, color);
      const firstIdx = positions.length / 3;

      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        addVertex(ccx + Math.cos(angle) * radius, ccy, ccz + Math.sin(angle) * radius, color);
      }

      for (let i = 0; i < segments; i++) {
        addTriangle(centerIdx, firstIdx + i, firstIdx + i + 1);
      }
    };

    // Ring outline
    const addRing = (ccx, ccy, ccz, innerRadius, outerRadius, segments, color) => {
      const firstInner = positions.length / 3;

      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        addVertex(ccx + cos * innerRadius, ccy, ccz + sin * innerRadius, color);
        addVertex(ccx + cos * outerRadius, ccy, ccz + sin * outerRadius, color);
      }

      for (let i = 0; i < segments; i++) {
        const base = firstInner + i * 2;
        addTriangle(base, base + 1, base + 2);
        addTriangle(base + 1, base + 3, base + 2);
      }
    };

    // Filled triangle
    const addFilledTriangle = (x1, y1, z1, x2, y2, z2, x3, y3, z3, color) => {
      const i1 = addVertex(x1, y1, z1, color);
      const i2 = addVertex(x2, y2, z2, color);
      const i3 = addVertex(x3, y3, z3, color);
      addTriangle(i1, i2, i3);
    };

    const baseWidth = r * 0.016;
    const bezelRadius = r * 0.82;
    const bezelWidth = r * 0.032;
    const dialRadius = bezelRadius * 0.78;  // Moved inward for tick room
    const dialWidth = r * 0.014;

    // === OUTER BEZEL ===
    addRing(cx, cy, cz, bezelRadius - bezelWidth, bezelRadius + bezelWidth, 64, palette.bezel);

    // === INNER DIAL RING ===
    addRing(cx, cy, cz, dialRadius - dialWidth, dialRadius + dialWidth, 56, palette.gimbal);

    // === CENTER PIVOT ===
    addDisc(cx, cy + r * 0.002, cz, r * 0.085, 16, palette.needleCenter);

    // === GRADUATION MARKS ===
    for (let deg = 0; deg < 360; deg += 5) {
      const angle = deg * Math.PI / 180;
      const isCardinal = deg % 90 === 0;
      const isMajor = deg % 15 === 0;

      let tickInner, tickOuter, tickWidth, tickColor;

      if (isCardinal) {
        tickInner = dialRadius * 1.03;
        tickOuter = bezelRadius * 0.94;
        tickWidth = baseWidth * 2.0;
        tickColor = deg === 0 ? palette.north : palette.tickCardinal;
      } else if (isMajor) {
        tickInner = dialRadius * 1.06;
        tickOuter = bezelRadius * 0.92;
        tickWidth = baseWidth * 1.4;
        tickColor = palette.tickMajor;
      } else {
        tickInner = dialRadius * 1.07;
        tickOuter = bezelRadius * 0.90;
        tickWidth = baseWidth * 1.0;
        tickColor = palette.tickFine;
      }

      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      addThickLine(
        cx + cosA * tickInner, cy, cz + sinA * tickInner,
        cx + cosA * tickOuter, cy, cz + sinA * tickOuter,
        tickColor, tickWidth
      );
    }

    // === NORTH MARKER ===
    const northBase = bezelRadius + bezelWidth * 1.2;
    const northTipDist = bezelRadius + bezelWidth * 2.5;
    const northWidth = r * 0.055;
    addFilledTriangle(
      cx + northTipDist, cy + r * 0.004, cz,
      cx + northBase, cy, cz - northWidth,
      cx + northBase, cy, cz + northWidth,
      palette.north
    );

    // === COMPASS NEEDLE ===
    const needleAngle = viewTheta + Math.PI;
    const needleLen = dialRadius * 0.90;
    const needleStart = r * 0.12;
    const cosN = Math.cos(needleAngle), sinN = Math.sin(needleAngle);

    // North needle (tapered triangle)
    const needleTipX = cx + cosN * needleLen;
    const needleTipZ = cz + sinN * needleLen;
    const needleBaseX = cx + cosN * needleStart;
    const needleBaseZ = cz + sinN * needleStart;
    const perpCos = Math.cos(needleAngle + Math.PI/2);
    const perpSin = Math.sin(needleAngle + Math.PI/2);

    addFilledTriangle(
      needleTipX, cy + r * 0.004, needleTipZ,
      needleBaseX + perpCos * baseWidth * 2.2, cy, needleBaseZ + perpSin * baseWidth * 2.2,
      needleBaseX - perpCos * baseWidth * 2.2, cy, needleBaseZ - perpSin * baseWidth * 2.2,
      palette.needleNorth
    );

    // Needle tip disc
    addDisc(needleTipX, cy + r * 0.004, needleTipZ, r * 0.030, 10, palette.needleNorth);

    // South needle (shorter, different color)
    const southAngle = needleAngle + Math.PI;
    const cosS = Math.cos(southAngle), sinS = Math.sin(southAngle);
    const southLen = needleLen * 0.60;
    const southTipX = cx + cosS * southLen;
    const southTipZ = cz + sinS * southLen;
    const southBaseX = cx + cosS * needleStart;
    const southBaseZ = cz + sinS * needleStart;
    const sPerpCos = Math.cos(southAngle + Math.PI/2);
    const sPerpSin = Math.sin(southAngle + Math.PI/2);

    addFilledTriangle(
      southTipX, cy + r * 0.004, southTipZ,
      southBaseX + sPerpCos * baseWidth * 2.0, cy, southBaseZ + sPerpSin * baseWidth * 2.0,
      southBaseX - sPerpCos * baseWidth * 2.0, cy, southBaseZ - sPerpSin * baseWidth * 2.0,
      palette.needleSouth
    );

    // === ELEVATION ARC (matches inner dial) ===
    const arcRadius2 = dialRadius * 0.68;
    const arcWidth = dialWidth;  // Match inner dial width
    const arcSegs = 28;

    for (let i = 0; i < arcSegs; i++) {
      const el1 = -Math.PI * 0.5 + (i / arcSegs) * Math.PI;
      const el2 = -Math.PI * 0.5 + ((i + 1) / arcSegs) * Math.PI;

      const x1 = arcRadius2 * Math.cos(el1), y1 = arcRadius2 * Math.sin(el1);
      const x2 = arcRadius2 * Math.cos(el2), y2 = arcRadius2 * Math.sin(el2);

      addThickLine3D(cx + x1, cy + y1, cz, cx + x2, cy + y2, cz, palette.arc, arcWidth);
    }

    // Elevation ticks
    for (const deg of [-90, -45, 0, 45, 90]) {
      const elRad = deg * Math.PI / 180;
      const isMajor = deg === 0 || Math.abs(deg) === 90;

      const arcX = arcRadius2 * Math.cos(elRad);
      const arcY = arcRadius2 * Math.sin(elRad);

      const tickLen = isMajor ? r * 0.038 : r * 0.024;
      const outX = (arcRadius2 + tickLen) * Math.cos(elRad);
      const outY = (arcRadius2 + tickLen) * Math.sin(elRad);

      addThickLine3D(
        cx + arcX, cy + arcY, cz,
        cx + outX, cy + outY, cz,
        palette.arcTick, isMajor ? baseWidth * 1.6 : baseWidth * 1.0
      );
    }

    // === ELEVATION INDICATOR ===
    const adjustedPhi = viewPhi - Math.PI * 0.5;
    const clampedEl = Math.max(-Math.PI * 0.5, Math.min(Math.PI * 0.5, adjustedPhi));
    const elX = arcRadius2 * Math.cos(clampedEl);
    const elY = arcRadius2 * Math.sin(clampedEl);

    addDisc(cx + elX, cy + elY, cz, r * 0.045, 12, palette.elevMarker);

    // Glow ring
    const glowColor = [palette.elevMarker[0], palette.elevMarker[1], palette.elevMarker[2], palette.elevMarker[3] * 0.35];
    addRing(cx + elX, cy + elY, cz, r * 0.045, r * 0.062, 12, glowColor);

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      colors: new Float32Array(colors),
      indices: new Uint16Array(indices),
      indexCount: indices.length,
      vertexCount: positions.length / 3,
      useTriangles: true
    };
  }

  // Update buffers for a view
  updateBuffers(viewState, cx, cy, cz, r, use3D, viewTheta, viewPhi, bgColor) {
    const gl = this.gl;

    if (use3D) {
      const geom = this.buildGeometry3D(cx, cy, cz, r, viewTheta, viewPhi, bgColor);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.normals, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.colors, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.DYNAMIC_DRAW);

      viewState.vertexCount = geom.vertexCount;
      viewState.indexCount = geom.indexCount;
      viewState.lineCount = geom.lineCount;

      viewState.lineData = {
        positions: geom.linePositions,
        normals: geom.lineNormals,
        colors: geom.lineColors
      };
    } else {
      const geom = this.buildGeometry2D(cx, cy, cz, r, viewTheta, viewPhi, bgColor);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.normals, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.colors, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.DYNAMIC_DRAW);

      viewState.vertexCount = geom.vertexCount;
      viewState.indexCount = geom.indexCount;
      viewState.lineCount = 0;
      viewState.lineData = null;
    }

    viewState.needsRebuild = false;
  }

  // Draw the orbit anchor for a view
  draw(params) {
    const {
      viewId,
      viewTheta,
      viewPhi,
      viewTarget,
      viewRadius,
      pointBoundsRadius,
      bgColor,
      use3D,
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      fogDensity,
      fogColor,
      lightingStrength,
      lightDir,
      navigationMode
    } = params;

    if (!this.showAnchor || navigationMode !== 'orbit') {
      return;
    }

    const gl = this.gl;
    const viewState = this.getViewState(viewId);

    const anchorRadius = this.computeAnchorRadius(pointBoundsRadius);

    // Check if rebuild needed
    const posChanged = viewTarget[0] !== viewState.lastX || viewTarget[1] !== viewState.lastY || viewTarget[2] !== viewState.lastZ;
    const sizeChanged = Math.abs(anchorRadius - (viewState.lastRadius || 0)) > 0.0005;
    const modeChanged = viewState.is3D !== use3D;
    const angleChanged = Math.abs(viewTheta - (viewState.lastTheta || 0)) > 0.01 || Math.abs(viewPhi - (viewState.lastPhi || 0)) > 0.01;

    const currentLuminance = bgColor[0] * 0.299 + bgColor[1] * 0.587 + bgColor[2] * 0.114;
    const bgChanged = Math.abs(currentLuminance - viewState.lastBgLuminance) > 0.1;

    if (viewState.needsRebuild || posChanged || sizeChanged || modeChanged || angleChanged || bgChanged || viewState.vertexCount === 0) {
      this.updateBuffers(viewState, viewTarget[0], viewTarget[1], viewTarget[2], anchorRadius, use3D, viewTheta, viewPhi, bgColor);
      viewState.lastX = viewTarget[0];
      viewState.lastY = viewTarget[1];
      viewState.lastZ = viewTarget[2];
      viewState.lastRadius = anchorRadius;
      viewState.lastTheta = viewTheta;
      viewState.lastPhi = viewPhi;
      viewState.lastBgLuminance = currentLuminance;
      viewState.is3D = use3D;

      if (use3D && viewState.lineData) {
        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.linePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, viewState.lineData.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineNormalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, viewState.lineData.normals, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, viewState.lineData.colors, gl.DYNAMIC_DRAW);
      }
    }

    if (viewState.vertexCount === 0) return;

    const fogNear = viewRadius * 0.2;
    const fogFar = viewRadius * 4.0;

    const camX = viewTarget[0] + viewRadius * Math.sin(viewTheta) * Math.cos(viewPhi);
    const camY = viewTarget[1] + viewRadius * Math.sin(viewPhi);
    const camZ = viewTarget[2] + viewRadius * Math.cos(viewTheta) * Math.cos(viewPhi);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (use3D) {
      gl.useProgram(this.program3D);
      gl.uniformMatrix4fv(this.uniforms3D.mvpMatrix, false, mvpMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.viewMatrix, false, viewMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.modelMatrix, false, modelMatrix);
      gl.uniform3f(this.uniforms3D.cameraPos, camX, camY, camZ);
      gl.uniform1f(this.uniforms3D.fogDensity, fogDensity);
      gl.uniform1f(this.uniforms3D.fogNear, fogNear);
      gl.uniform1f(this.uniforms3D.fogFar, fogFar);
      gl.uniform3fv(this.uniforms3D.fogColor, fogColor);
      gl.uniform1f(this.uniforms3D.lightingStrength, lightingStrength);
      gl.uniform3fv(this.uniforms3D.lightDir, lightDir);
      gl.uniform1f(this.uniforms3D.emissive, 0.12);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.enableVertexAttribArray(this.attribs3D.position);
      gl.vertexAttribPointer(this.attribs3D.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.enableVertexAttribArray(this.attribs3D.normal);
      gl.vertexAttribPointer(this.attribs3D.normal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.enableVertexAttribArray(this.attribs3D.color);
      gl.vertexAttribPointer(this.attribs3D.color, 4, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.drawElements(gl.TRIANGLES, viewState.indexCount, gl.UNSIGNED_SHORT, 0);

      if (viewState.lineCount > 0 && viewState.lineData) {
        gl.uniform1f(this.uniforms3D.emissive, 0.0);

        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.linePositionBuffer);
        gl.vertexAttribPointer(this.attribs3D.position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineNormalBuffer);
        gl.vertexAttribPointer(this.attribs3D.normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineColorBuffer);
        gl.vertexAttribPointer(this.attribs3D.color, 4, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.LINES, 0, viewState.lineCount);
      }

      gl.disableVertexAttribArray(this.attribs3D.position);
      gl.disableVertexAttribArray(this.attribs3D.normal);
      gl.disableVertexAttribArray(this.attribs3D.color);
    } else {
      // 2D mode uses triangles with minimal lighting
      gl.useProgram(this.program3D);
      gl.uniformMatrix4fv(this.uniforms3D.mvpMatrix, false, mvpMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.viewMatrix, false, viewMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.modelMatrix, false, modelMatrix);
      gl.uniform3f(this.uniforms3D.cameraPos, camX, camY, camZ);
      gl.uniform1f(this.uniforms3D.fogDensity, fogDensity);
      gl.uniform1f(this.uniforms3D.fogNear, fogNear);
      gl.uniform1f(this.uniforms3D.fogFar, fogFar);
      gl.uniform3fv(this.uniforms3D.fogColor, fogColor);
      gl.uniform1f(this.uniforms3D.lightingStrength, 0.25);
      gl.uniform3fv(this.uniforms3D.lightDir, lightDir);
      gl.uniform1f(this.uniforms3D.emissive, 0.45);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.enableVertexAttribArray(this.attribs3D.position);
      gl.vertexAttribPointer(this.attribs3D.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.enableVertexAttribArray(this.attribs3D.normal);
      gl.vertexAttribPointer(this.attribs3D.normal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.enableVertexAttribArray(this.attribs3D.color);
      gl.vertexAttribPointer(this.attribs3D.color, 4, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.drawElements(gl.TRIANGLES, viewState.indexCount, gl.UNSIGNED_SHORT, 0);

      gl.disableVertexAttribArray(this.attribs3D.position);
      gl.disableVertexAttribArray(this.attribs3D.normal);
      gl.disableVertexAttribArray(this.attribs3D.color);
    }
  }

  setShowAnchor(show) {
    this.showAnchor = !!show;
    if (show) this.markAllNeedsRebuild();
  }

  getShowAnchor() {
    return this.showAnchor;
  }

  updateLabels() {}
}
