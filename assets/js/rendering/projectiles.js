/**
 * Projectile system
 * =================
 * Encapsulates all projectile and impact physics + GPU buffers.
 *
 * This module is intentionally stateless w.r.t. viewer internals:
 * everything it needs is passed in via the factory config or via
 * small getter callbacks so that viewer.js owns camera and data.
 */

import { configureStraightAlphaBlending } from './gl-utils.js';
import {
  readPositionBounds,
  readPositionXYZ,
  requirePositionArray,
} from './position-layout.js';

/** Seconds a press must be held before a shot starts building charge. */
export const PROJECTILE_MIN_CHARGE_SECONDS = 0.08;

export function createProjectileSystem({
  gl,
  canvas,
  mat4,
  vec3,
  vec4,
  hpRenderer,
  physicsTickRate,
  getPointCount,
  getPositionsArray,
  getColorsArray,
  getCursorPosition,
  centroidProgram,
  centroidAttribLocations,
  centroidUniformLocations,
  // For charge indicator
  getLassoCtx,
  getPointerLockActive,
  getNavigationMode,
  // The backdrop surfaces to bounce off (`{ kind: 'box' | 'floor', ... }` or null)
  getCollisionStage,
  // For dimension-aware spatial index
  getCurrentDimensionLevel = () => 3,
}) {
  // Projectile buffers (small, dynamic)
  // Color buffers store RGBA as uint8 (alpha packed in)
  let projectilePositionBuffer = gl.createBuffer();
  let projectileColorBuffer = gl.createBuffer(); // RGBA uint8
  let impactPositionBuffer = gl.createBuffer();
  let impactColorBuffer = gl.createBuffer(); // RGBA uint8
  // Each pass owns its vertex array, so its attribute state never lands on
  // whichever vertex array another pass left bound.
  let projectileVao = gl.createVertexArray();
  let impactVao = gl.createVertexArray();

  // Projectile sandbox state
  const projectiles = [];
  const impactFlashes = [];
  let projectilesEnabled = false;
  let disposeRequested = false;
  let disposed = false;
  let projectileBufferDirty = true;
  let impactBufferDirty = true;
  // Staging for the per-frame vertex uploads. They grow to the largest frame
  // seen and are reused: while anything is in flight they are refilled every
  // frame, and a fresh pair of typed arrays per frame was garbage the
  // collector then had to reclaim mid-animation. Only the leading
  // `projectilePointCount` / `impactFlashes.length` records are live.
  let projectilePositions = new Float32Array();
  let projectileColors = new Uint8Array(); // RGBA packed as uint8
  let impactPositions = new Float32Array();
  let impactColors = new Uint8Array(); // RGBA packed as uint8

  function stagingCapacity(current, required) {
    return current >= required
      ? current
      : Math.max(required, Math.ceil(current * 1.5));
  }
  let lastShotTime = 0;
  let pointBounds = {
    min: [-1, -1, -1],
    max: [1, 1, 1],
    center: [0, 0, 0],
    radius: 3,
  };
  let pointCollisionRadius = 0.02;

  // Scratch vectors
  const tempVec3 = vec3.create();
  const tempVec3b = vec3.create();
  const tempVec3c = vec3.create();
  const tempVec4a = vec4.create();
  const tempVec4b = vec4.create();

  // Physics / tuning constants (mirrors original viewer.js values)
  const PROJECTILE_RADIUS = 0.05;        // Bigger projectile
  const PROJECTILE_TRAIL_DELAY = 0.12;   // Seconds before trail starts
  const PROJECTILE_SPEED = 3.0;          // Snappy and responsive
  const PROJECTILE_GRAVITY = 9.8 * 0.15; // Noticeable arcs without feeling heavy
  const PROJECTILE_DRAG = 0.995;         // Increased drag for smoother deceleration
  const PROJECTILE_LIFETIME = 12.0;      // Reasonable lifetime
  const PROJECTILE_BOUNCE = 0.35;        // Moderate restitution for visible bounces
  const PROJECTILE_FRICTION = 0.85;      // Higher friction for more energy loss on slide
  const PROJECTILE_TRAIL_LENGTH = 16;    // Number of trail segments
  const PROJECTILE_TRAIL_SPACING = 0.004; // Seconds between trail samples (~60fps)
  const PROJECTILE_FLASH_TIME = 0.6;
  const MAX_PROJECTILES = 32;
  const MAX_IMPACT_FLASHES = 128;
  const PROJECTILE_SPREAD = 0;          // No spread - shoots exactly where aimed
  const PROJECTILE_LOFT = 0.01;         // Upward angle bias for arcing shots
  const SHOT_COOLDOWN_SECONDS = 0.05;
  const COLLISION_COOLDOWN = 0.05;      // Seconds between bounces (prevents multi-cell chaos)
  const MAX_VELOCITY = 8.0;             // Cap velocity to prevent runaway speeds
  const MIN_BOUNCE_VELOCITY = 0.1;      // Below this speed, projectile stops bouncing
  const FLOOR_CONTACT_TOLERANCE = 1e-5; // Rounding slack for a projectile resting on the floor

  // Charge system constants
  const MAX_CHARGE_TIME = 1.0;          // Seconds to reach full charge
  const MIN_SPEED_MULT = 1.0;           // Speed multiplier at min charge
  const MAX_SPEED_MULT = 3.5;           // Speed multiplier at full charge
  const VISUAL_CHARGE_DELAY = 0.2;      // Seconds before indicator appears (quick shots show nothing)

  // Charge system state
  let isCharging = false;
  let chargeStartTime = 0;
  let chargeLevel = 0;
  let chargeViewportInfo = null;
  let chargeIndicatorNeedsClear = false;
  let contextLossChargeIndicatorNeedsClear = false;

  // Track total projectile points for draw call
  let projectilePointCount = 0;

  // Helper to fetch a normalized RGB color for a point index.
  function getNormalizedColor(idx) {
    const colorsArray = getColorsArray();
    const pointCount = getPointCount();
    if (!colorsArray || !pointCount) return [1.0, 0.6, 0.2];
    const stride = colorsArray.length === pointCount * 4 ? 4 : 3;
    const base = idx * stride;
    const scale = colorsArray.BYTES_PER_ELEMENT === 1 ? (1 / 255) : 1;
    return [
      (colorsArray[base] || 0) * scale,
      (colorsArray[base + 1] || 0) * scale,
      (colorsArray[base + 2] || 0) * scale,
    ];
  }

  function computePointBoundsFromPositions(positions, dimension) {
    if (!positions || positions.length < dimension) {
      pointBounds = {
        min: [-1, -1, -1],
        max: [1, 1, 1],
        center: [0, 0, 0],
        radius: 3,
      };
      pointCollisionRadius = 0.02;
      return;
    }
    requirePositionArray(
      positions,
      dimension,
      'Projectile bounds positions'
    );
    // The renderer scans the same published array; both read one cached scan.
    const { min, max } = readPositionBounds(positions, dimension);
    const [minX, minY, minZ] = min;
    const [maxX, maxY, maxZ] = max;
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const radius = Math.max(0.0001, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5);
    pointBounds = {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [centerX, centerY, centerZ],
      radius,
    };
    pointCollisionRadius = Math.max(0.01, radius * 0.01);
  }

  function queryNearbyPoints(center, radius, maxResults = 64) {
    const positionsArray = getPositionsArray();
    if (!(positionsArray instanceof Float32Array) || positionsArray.length < 3) {
      throw new TypeError(
        'Projectile collision queries require the published Float32 position array.'
      );
    }

    const dimLevel = getCurrentDimensionLevel();
    hpRenderer.ensureSpatialIndex(dimLevel);
    const spatialIndex =
      hpRenderer.spatialIndices.get(dimLevel) ?? null;
    if (!spatialIndex) {
      throw new Error(
        `Projectile collision spatial index for ${dimLevel}D data was not published.`
      );
    }

    if (
      spatialIndex.dimensionLevel !== dimLevel ||
      positionsArray.length !== spatialIndex.pointCount * dimLevel
    ) {
      throw new Error(
        `Projectile collision spatial index does not own the published ${dimLevel}D positions.`
      );
    }
    const indices = spatialIndex.queryRadius(center, radius, maxResults);
    return indices.map((idx) => ({
      index: idx,
      position: readPositionXYZ(positionsArray, dimLevel, idx, [0, 0, 0]),
      color: getNormalizedColor(idx),
    }));
  }

  function pickProjectileColor() {
    const colorsArray = getColorsArray();
    const pointCount = getPointCount();
    if (colorsArray && pointCount > 0) {
      const idx = Math.floor(Math.random() * pointCount);
      return getNormalizedColor(idx);
    }
    return [1.0, 0.6, 0.2];
  }

  // Compute aim direction from cursor screen position (for aiming without
  // pointer lock). `viewportInfo` is the pane the shot was charged in, as the
  // viewer's presented layout resolved it: its render rectangle
  // (`vpOffsetX/Y`, `vpWidth/Height`, canvas-local CSS pixels), the exact
  // projection the pane is drawn with, and the pane camera.
  function getAimDirectionFromCursor(viewportInfo) {
    const rect = canvas.getBoundingClientRect();
    const cursor = getCursorPosition();
    const {
      vpWidth,
      vpHeight,
      vpOffsetX,
      vpOffsetY,
      projectionMatrix
    } = viewportInfo;

    // Convert cursor position to normalized device coordinates (-1 to 1) relative to viewport
    const localX = cursor.x - rect.left - vpOffsetX;
    const localY = cursor.y - rect.top - vpOffsetY;
    const ndcX = (localX / vpWidth) * 2 - 1;
    const ndcY = -(localY / vpHeight) * 2 + 1;  // Flip Y for GL

    // Create ray in clip space at near plane
    const nearPoint = vec4.set(tempVec4a, ndcX, ndcY, -1, 1);
    const farPoint = vec4.set(tempVec4b, ndcX, ndcY, 1, 1);

    // Get inverse view-projection matrix
    const tempViewProj = mat4.create();
    const invViewProj = mat4.create();

    // Build the pane camera's view matrix.
    const freeflyPosition = viewportInfo.cameraPosition;
    const axes = viewportInfo.cameraAxes;
    const { forward: camForward, upVec } = axes;
    const tempView = mat4.create();
    const lookTarget = vec3.add(vec3.create(), freeflyPosition, camForward);
    mat4.lookAt(tempView, freeflyPosition, lookTarget, upVec);

    mat4.multiply(tempViewProj, projectionMatrix, tempView);
    mat4.invert(invViewProj, tempViewProj);

    // Unproject to world space
    vec4.transformMat4(nearPoint, nearPoint, invViewProj);
    vec4.transformMat4(farPoint, farPoint, invViewProj);

    // Perspective divide
    const origin = vec3.set(
      tempVec3,
      nearPoint[0] / nearPoint[3],
      nearPoint[1] / nearPoint[3],
      nearPoint[2] / nearPoint[3],
    );
    const farWorld = vec3.set(
      tempVec3b,
      farPoint[0] / farPoint[3],
      farPoint[1] / farPoint[3],
      farPoint[2] / farPoint[3],
    );

    // Direction from near to far
    const direction = vec3.sub(vec3.create(), farWorld, origin);
    vec3.normalize(direction, direction);
    return direction;
  }

  // viewportInfo: the pane the shot leaves from ({ cameraPosition, cameraAxes }
  // always; plus vpWidth, vpHeight, vpOffsetX, vpOffsetY and projectionMatrix
  // when aiming at the cursor).
  // speedMultiplier: optional speed boost (1.0 = default, higher = faster)
  function spawnProjectile({ navigationMode, pointerLockActive, viewportInfo, speedMultiplier = 1.0 }) {
    if (navigationMode !== 'free') return;
    if (!projectilesEnabled) return;
    if (
      viewportInfo === null ||
      typeof viewportInfo !== 'object' ||
      !viewportInfo.cameraAxes ||
      !viewportInfo.cameraPosition
    ) {
      throw new TypeError('A projectile requires the pane camera it is fired from.');
    }
    const now = performance.now();
    if (now - lastShotTime < SHOT_COOLDOWN_SECONDS * 1000) return;
    lastShotTime = now;

    const axes = viewportInfo.cameraAxes;
    const cameraPosition = viewportInfo.cameraPosition;

    // Use cursor-based aiming when not in pointer lock mode, otherwise use camera forward
    const aimDirection = pointerLockActive
      ? axes.forward
      : getAimDirectionFromCursor(viewportInfo);

    // Add slight random spread and upward loft for arcing shots
    const spreadDir = vec3.clone(aimDirection);
    const randRight = (Math.random() - 0.5) * 2 * PROJECTILE_SPREAD;
    const randUp = (Math.random() - 0.5) * 2 * PROJECTILE_SPREAD;
    vec3.scaleAndAdd(spreadDir, spreadDir, axes.right, randRight);
    vec3.scaleAndAdd(spreadDir, spreadDir, axes.upVec, randUp);
    // Add upward loft for higher arcing trajectory (scaled with speed for charged shots)
    spreadDir[1] += PROJECTILE_LOFT * speedMultiplier;
    vec3.normalize(spreadDir, spreadDir);

    // Start projectile very close to camera for bigger initial appearance
    const start = vec3.add(
      vec3.create(),
      cameraPosition,
      vec3.scale(vec3.create(), spreadDir, 0.005),
    );
    // Apply speed multiplier for charged shots
    const finalSpeed = PROJECTILE_SPEED * Math.max(1.0, speedMultiplier);
    const vel = vec3.scale(vec3.create(), spreadDir, finalSpeed);
    projectiles.push({
      position: start,
      velocity: vel,
      color: pickProjectileColor(),
      radius: PROJECTILE_RADIUS,
      age: 0,
      trail: [],           // Ring buffer of past positions [x,y,z, x,y,z, ...]
      trailTime: -PROJECTILE_TRAIL_DELAY,  // Negative = delay before trail starts
      lastBounceTime: 0,   // Cooldown to prevent multi-cell bounce chaos
    });
    if (projectiles.length > MAX_PROJECTILES) projectiles.shift();
    projectileBufferDirty = true;
  }

  function recordImpact(position, color) {
    impactFlashes.push({
      position: [position[0], position[1], position[2]],
      color: color || [1, 1, 1],
      age: 0,
      life: PROJECTILE_FLASH_TIME,
    });
    if (impactFlashes.length > MAX_IMPACT_FLASHES) impactFlashes.shift();
    impactBufferDirty = true;
  }

  function updateImpactFlashes(dt) {
    if (!impactFlashes.length) return;
    let anyRemoved = false;
    for (let i = impactFlashes.length - 1; i >= 0; i--) {
      const flash = impactFlashes[i];
      flash.age += dt;
      if (flash.age >= flash.life) {
        impactFlashes.splice(i, 1);
        anyRemoved = true;
      }
    }
    if (anyRemoved || dt > 0) impactBufferDirty = true;
  }

  /**
   * Reflect one axis of a projectile off a plane it is crossing. The other
   * two axes lose a little speed to friction; a projectile whose rebound
   * would be too slow to see stays on the surface instead of jittering.
   */
  function bounceOffPlane(p, axis, planeCoordinate) {
    const pos = p.position;
    const vel = p.velocity;
    pos[axis] = planeCoordinate;
    const rebound = -vel[axis] * PROJECTILE_BOUNCE;
    vel[axis] = Math.abs(rebound) < MIN_BOUNCE_VELOCITY ? 0 : rebound;
    for (let other = 0; other < 3; other++) {
      if (other !== axis) vel[other] *= (1.0 - PROJECTILE_FRICTION * 0.5);
    }
    p.lastBounceTime = p.age;
  }

  /**
   * Keep a projectile on the inside of the backdrop: the grid's six walls,
   * or the studio floor (a plane bounded by the stage it draws). `startY` is
   * the projectile's height at the start of this substep.
   */
  function collideWithStage(p, stage, startY) {
    const pos = p.position;
    const vel = p.velocity;
    const radius = PROJECTILE_RADIUS * 0.5; // Smaller collision radius for surfaces
    if (stage.kind === 'box') {
      for (let axis = 0; axis < 3; axis++) {
        if (pos[axis] - radius < stage.min && vel[axis] < 0) {
          bounceOffPlane(p, axis, stage.min + radius);
        } else if (pos[axis] + radius > stage.max && vel[axis] > 0) {
          bounceOffPlane(p, axis, stage.max - radius);
        }
      }
      return;
    }
    // The floor: only from above, and only over the stage.
    if (pos[1] - radius >= stage.y || vel[1] > 0) return;
    const dx = pos[0] - stage.centerX;
    const dz = pos[2] - stage.centerZ;
    if (dx * dx + dz * dz > stage.radius * stage.radius) return;
    // Only a projectile that crossed the floor during this substep lands on
    // it; one that was already below (it fell past the stage's edge) keeps
    // falling. The test is against the height a landed projectile is put
    // at, with a tolerance, so one resting there is never read as below.
    const contactY = stage.y + radius;
    if (startY < contactY - FLOOR_CONTACT_TOLERANCE) return;
    bounceOffPlane(p, 1, contactY);
  }

  function stepProjectiles(dt) {
    if (!projectiles.length) return;
    const maxRange = pointBounds.radius * 3 + 1.0;
    const collisionRadius = PROJECTILE_RADIUS + pointCollisionRadius;
    const stage = getCollisionStage?.() ?? null;

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.age += dt;
      if (p.age > PROJECTILE_LIFETIME) {
        projectiles.splice(i, 1);
        projectileBufferDirty = true;
        continue;
      }

      // Sample trail position at regular intervals
      p.trailTime += dt;
      if (p.trailTime >= PROJECTILE_TRAIL_SPACING) {
        p.trailTime = 0;
        // Push current position to trail (stored as flat array for performance)
        p.trail.push(p.position[0], p.position[1], p.position[2]);
        // Trim trail to max length (each position is 3 floats)
        const maxTrailFloats = PROJECTILE_TRAIL_LENGTH * 3;
        if (p.trail.length > maxTrailFloats) {
          p.trail.splice(0, 3); // Remove oldest position
        }
      }

      // Calculate sub-steps based on velocity to prevent tunneling
      const speed = vec3.length(p.velocity);
      const moveDistance = speed * dt;
      // Keep each physics step very short to prevent tunneling through cells
      // Use half the collision radius to ensure we never skip over a cell
      const maxStepDistance = collisionRadius * 0.4;
      const numSubSteps = Math.max(4, Math.ceil(moveDistance / maxStepDistance));
      const subDt = dt / numSubSteps;
      const gravitySubStep = PROJECTILE_GRAVITY * subDt;
      const subDrag = Math.pow(PROJECTILE_DRAG, subDt * physicsTickRate);

      let outOfBounds = false;

      for (let step = 0; step < numSubSteps; step++) {
        // Apply physics
        const startY = p.position[1];
        p.velocity[1] -= gravitySubStep;
        vec3.scale(p.velocity, p.velocity, subDrag);
        vec3.scaleAndAdd(p.position, p.position, p.velocity, subDt);

        // Check bounds
        const dx = p.position[0] - pointBounds.center[0];
        const dy = p.position[1] - pointBounds.center[1];
        const dz = p.position[2] - pointBounds.center[2];
        const distFromCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distFromCenter > maxRange) {
          outOfBounds = true;
          break;
        }

        // Check collisions against the exact full-resolution cell positions.
        const pointCount = getPointCount();
        const canBounce = p.age - p.lastBounceTime >= COLLISION_COOLDOWN;

        if (pointCount > 0 && !p.resting && canBounce) {
          const hits = queryNearbyPoints(p.position, collisionRadius * 2.0, 48);

          let closestHit = null;
          let closestDist = Infinity;

          for (const hit of hits) {
            vec3.sub(tempVec3, p.position, hit.position);
            const d = vec3.length(tempVec3);
            if (d > 1e-5 && d < collisionRadius * 1.2 && d < closestDist) {
              closestDist = d;
              closestHit = hit;
            }
          }

          if (closestHit) {
            vec3.sub(tempVec3, p.position, closestHit.position);
            vec3.scale(tempVec3, tempVec3, 1 / closestDist);
            const vDotN = vec3.dot(p.velocity, tempVec3);
            const speed = vec3.length(p.velocity);
            if (vDotN < 0) {
              if (speed < MIN_BOUNCE_VELOCITY) {
                vec3.set(p.velocity, 0, 0, 0);
                p.resting = true;
              } else {
                vec3.scale(tempVec3b, tempVec3, vDotN);
                vec3.sub(tempVec3c, p.velocity, tempVec3b);
                vec3.scale(tempVec3b, tempVec3b, -PROJECTILE_BOUNCE);
                vec3.scale(tempVec3c, tempVec3c, 1.0 - PROJECTILE_FRICTION);
                vec3.add(p.velocity, tempVec3b, tempVec3c);

                const newSpeed = vec3.length(p.velocity);
                if (newSpeed > MAX_VELOCITY) {
                  vec3.scale(p.velocity, p.velocity, MAX_VELOCITY / newSpeed);
                }

                const penetration = collisionRadius - closestDist;
                if (penetration > 0) {
                  vec3.scaleAndAdd(p.position, p.position, tempVec3, penetration + 0.005);
                }

                p.lastBounceTime = p.age;
              }

              recordImpact(closestHit.position, closestHit.color || pickProjectileColor());
            }
          }
        }

        // The backdrop is solid even under a projectile that came to rest on
        // a cell: gravity still pulls a resting projectile, so without this it
        // would fall through the floor.
        if (stage) collideWithStage(p, stage, startY);
      }

      if (outOfBounds) {
        projectiles.splice(i, 1);
        projectileBufferDirty = true;
        continue;
      }
    }

    if (projectiles.length) projectileBufferDirty = true;
  }

  function rebuildProjectileBuffers() {
    const count = projectiles.length;
    if (count === 0) {
      projectilePositions = new Float32Array();
      projectileColors = new Uint8Array();
      projectilePointCount = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, projectilePositionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, projectilePositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, projectileColors, gl.DYNAMIC_DRAW);
      projectileBufferDirty = false;
      return;
    }

    // Count total points: head + trail for each projectile
    let totalPoints = 0;
    for (let i = 0; i < count; i++) {
      totalPoints += 1 + (projectiles[i].trail.length / 3);
    }

    const capacity = stagingCapacity(projectilePositions.length / 3, totalPoints);
    if (capacity * 3 !== projectilePositions.length) {
      projectilePositions = new Float32Array(capacity * 3);
      projectileColors = new Uint8Array(capacity * 4);
    }
    let pointIndex = 0;

    for (let i = 0; i < count; i++) {
      const p = projectiles[i];
      const r = Math.round(p.color[0] * 255);
      const g = Math.round(p.color[1] * 255);
      const b = Math.round(p.color[2] * 255);
      const trailCount = p.trail.length / 3;

      // Write trail points first (oldest to newest, fading alpha)
      for (let t = 0; t < trailCount; t++) {
        const posBase = pointIndex * 3;
        const colBase = pointIndex * 4;
        const trailBase = t * 3;

        projectilePositions[posBase] = p.trail[trailBase];
        projectilePositions[posBase + 1] = p.trail[trailBase + 1];
        projectilePositions[posBase + 2] = p.trail[trailBase + 2];

        // Alpha fades from ~20 (oldest) to ~180 (newest)
        const alpha = Math.round(20 + (t / Math.max(1, trailCount - 1)) * 160);
        projectileColors[colBase] = r;
        projectileColors[colBase + 1] = g;
        projectileColors[colBase + 2] = b;
        projectileColors[colBase + 3] = alpha;
        pointIndex++;
      }

      // Write head point (full alpha, brightest)
      const posBase = pointIndex * 3;
      const colBase = pointIndex * 4;
      projectilePositions[posBase] = p.position[0];
      projectilePositions[posBase + 1] = p.position[1];
      projectilePositions[posBase + 2] = p.position[2];
      projectileColors[colBase] = r;
      projectileColors[colBase + 1] = g;
      projectileColors[colBase + 2] = b;
      projectileColors[colBase + 3] = 255;
      pointIndex++;
    }

    projectilePointCount = totalPoints;
    gl.bindBuffer(gl.ARRAY_BUFFER, projectilePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, projectilePositions, gl.DYNAMIC_DRAW, 0, totalPoints * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, projectileColors, gl.DYNAMIC_DRAW, 0, totalPoints * 4);
    projectileBufferDirty = false;
  }

  function rebuildImpactBuffers() {
    const count = impactFlashes.length;
    if (count === 0) {
      impactPositions = new Float32Array();
      impactColors = new Uint8Array();
      gl.bindBuffer(gl.ARRAY_BUFFER, impactPositionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, impactPositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, impactColors, gl.DYNAMIC_DRAW);
      impactBufferDirty = false;
      return;
    }

    const capacity = stagingCapacity(impactPositions.length / 3, count);
    if (capacity * 3 !== impactPositions.length) {
      impactPositions = new Float32Array(capacity * 3);
      impactColors = new Uint8Array(capacity * 4); // RGBA packed
    }
    for (let i = 0; i < count; i++) {
      const flash = impactFlashes[i];
      const posBase = i * 3;
      const colBase = i * 4;
      const alpha = Math.max(0, 1 - (flash.age / flash.life));
      impactPositions[posBase] = flash.position[0];
      impactPositions[posBase + 1] = flash.position[1];
      impactPositions[posBase + 2] = flash.position[2];
      // Convert float 0-1 to uint8 0-255
      impactColors[colBase] = Math.round(flash.color[0] * 255);
      impactColors[colBase + 1] = Math.round(flash.color[1] * 255);
      impactColors[colBase + 2] = Math.round(flash.color[2] * 255);
      impactColors[colBase + 3] = Math.round(alpha * 255); // alpha fades over time
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, impactPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, impactPositions, gl.DYNAMIC_DRAW, 0, count * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, impactColors, gl.DYNAMIC_DRAW, 0, count * 4);
    impactBufferDirty = false;
  }

  function drawProjectiles({
    viewportHeight,
    mvpMatrix,
    viewMatrix,
    modelMatrix,
    basePointSize,
    sizeAttenuation,
    fov,
  }) {
    if (projectilePointCount === 0) return;

    configureStraightAlphaBlending(gl);
    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    // Use the same point size as data points so bullets match
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

    gl.bindVertexArray(projectileVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, projectilePositionBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(
      centroidAttribLocations.color,
      4,
      gl.UNSIGNED_BYTE,
      true,
      0,
      0,
    ); // RGBA uint8 normalized

    gl.drawArrays(gl.POINTS, 0, projectilePointCount);
    gl.bindVertexArray(null);
  }

  function drawImpactFlashes({
    viewportHeight,
    mvpMatrix,
    viewMatrix,
    modelMatrix,
    basePointSize,
    sizeAttenuation,
    fov,
  }) {
    const count = impactFlashes.length;
    if (count === 0) return;

    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    // Impact flashes are larger for visual pop
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize * 1.8);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

    let renderFailure;
    try {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA
      );

      gl.bindVertexArray(impactVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, impactPositionBuffer);
      gl.enableVertexAttribArray(centroidAttribLocations.position);
      gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
      gl.enableVertexAttribArray(centroidAttribLocations.color);
      gl.vertexAttribPointer(
        centroidAttribLocations.color,
        4,
        gl.UNSIGNED_BYTE,
        true,
        0,
        0,
      ); // RGBA uint8 normalized

      gl.drawArrays(gl.POINTS, 0, count);
    } catch (error) {
      renderFailure = error;
    }
    try {
      gl.bindVertexArray(null);
      configureStraightAlphaBlending(gl);
    } catch (settlementFailure) {
      if (renderFailure !== undefined) {
        throw new AggregateError(
          [renderFailure, settlementFailure],
          'Projectile impact rendering and blend-state settlement both failed.'
        );
      }
      throw settlementFailure;
    }
    if (renderFailure !== undefined) throw renderFailure;
  }

  // ========== Charge Indicator System ==========

  function drawChargeIndicator() {
    if (!isCharging || getNavigationMode() !== 'free' || !projectilesEnabled) return;

    const lassoCtx = getLassoCtx();
    if (!lassoCtx) return;

    // Update charge level
    const chargeTime = (performance.now() - chargeStartTime) / 1000;
    if (chargeTime < PROJECTILE_MIN_CHARGE_SECONDS) {
      chargeLevel = 0;
    } else {
      chargeLevel = Math.min(1.0, (chargeTime - PROJECTILE_MIN_CHARGE_SECONDS) / (MAX_CHARGE_TIME - PROJECTILE_MIN_CHARGE_SECONDS));
    }

    // Don't show indicator for quick shots - only after holding 200ms+
    if (chargeTime < VISUAL_CHARGE_DELAY) return;

    const rect = canvas.getBoundingClientRect();
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    lassoCtx.scale(dpr, dpr);

    // Under pointer lock the shot flies along the camera's forward axis,
    // which projects to the charged pane's principal point; otherwise it
    // flies at the cursor.
    let cx, cy;
    if (getPointerLockActive()) {
      const pane = chargeViewportInfo;
      cx = pane.vpOffsetX + (pane.projectionCenterNdcX + 1) * 0.5 * pane.vpWidth;
      cy = pane.vpOffsetY + pane.vpHeight / 2;
    } else {
      const cursor = getCursorPosition();
      cx = cursor.x - rect.left;
      cy = cursor.y - rect.top;
    }

    // Ring parameters - compact design
    const outerRadius = 20;
    const ringWidth = 8;

    // Clear previous frame's indicator area
    lassoCtx.clearRect(cx - 30, cy - 30, 60, 60);
    // The overlay is hidden while empty (highlight-renderer.js).
    const overlayStyle = lassoCtx.canvas?.style;
    if (overlayStyle && overlayStyle.display !== '') overlayStyle.display = '';

    // Color interpolation: white → yellow → orange → red
    let r, g, b;
    if (chargeLevel < 0.33) {
      const t = chargeLevel * 3;
      r = 255;
      g = 255;
      b = Math.round(255 * (1 - t));
    } else if (chargeLevel < 0.66) {
      const t = (chargeLevel - 0.33) * 3;
      r = 255;
      g = Math.round(255 - t * 90);
      b = 0;
    } else {
      const t = (chargeLevel - 0.66) * 3;
      r = 255;
      g = Math.round(165 - t * 165);
      b = 0;
    }
    const arcColor = `rgb(${r}, ${g}, ${b})`;

    // Publish cleanup ownership before the first drawing operation. If a
    // Canvas2D call fails after partially painting the ring, disabling or
    // disposing the system will still retry the clear.
    chargeIndicatorNeedsClear = true;

    // Draw background ring (subtle dark outline)
    lassoCtx.beginPath();
    lassoCtx.arc(cx, cy, outerRadius - ringWidth / 2, 0, Math.PI * 2);
    lassoCtx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    lassoCtx.lineWidth = ringWidth + 2;
    lassoCtx.stroke();

    // Draw empty ring track
    lassoCtx.beginPath();
    lassoCtx.arc(cx, cy, outerRadius - ringWidth / 2, 0, Math.PI * 2);
    lassoCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    lassoCtx.lineWidth = ringWidth;
    lassoCtx.stroke();

    // Draw filled arc (starts at top, goes clockwise)
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + (chargeLevel * Math.PI * 2);

    lassoCtx.beginPath();
    lassoCtx.arc(cx, cy, outerRadius - ringWidth / 2, startAngle, endAngle);
    lassoCtx.strokeStyle = arcColor;
    lassoCtx.lineWidth = ringWidth;
    lassoCtx.lineCap = 'round';
    lassoCtx.stroke();
    lassoCtx.lineCap = 'butt';

    // Glow effect at high charge
    if (chargeLevel >= 0.7) {
      const glowIntensity = (chargeLevel - 0.7) / 0.3;
      const pulse = chargeLevel >= 0.95 ? (0.6 + 0.4 * Math.sin(performance.now() * 0.015)) : 1;
      lassoCtx.beginPath();
      lassoCtx.arc(cx, cy, outerRadius - ringWidth / 2, startAngle, endAngle);
      lassoCtx.strokeStyle = arcColor;
      lassoCtx.lineWidth = ringWidth;
      lassoCtx.shadowColor = arcColor;
      lassoCtx.shadowBlur = 8 * glowIntensity * pulse;
      lassoCtx.stroke();
      lassoCtx.shadowBlur = 0;
    }
  }

  function clearChargeIndicator(force = false) {
    if (!force && !chargeIndicatorNeedsClear) return;
    const lassoCtx = getLassoCtx();
    if (!lassoCtx) {
      chargeIndicatorNeedsClear = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    lassoCtx.scale(dpr, dpr);
    lassoCtx.clearRect(0, 0, rect.width, rect.height);
    const overlayStyle = lassoCtx.canvas?.style;
    if (overlayStyle && overlayStyle.display !== 'none') overlayStyle.display = 'none';
    chargeIndicatorNeedsClear = false;
  }

  function startCharging(viewportInfo) {
    if (!projectilesEnabled || disposeRequested) return;
    isCharging = true;
    chargeStartTime = performance.now();
    chargeLevel = 0;
    chargeViewportInfo = viewportInfo;
  }

  function cancelCharging() {
    const needsClear = isCharging || chargeIndicatorNeedsClear;
    isCharging = false;
    chargeLevel = 0;
    chargeViewportInfo = null;
    if (needsClear) {
      clearChargeIndicator();
    }
  }

  function stopChargingAndFire({ navigationMode, pointerLockActive, viewportInfo }) {
    if (!isCharging) return;

    isCharging = false;
    const chargeTime = (performance.now() - chargeStartTime) / 1000;

    // Calculate speed multiplier based on charge time
    let speedMultiplier = MIN_SPEED_MULT;
    if (chargeTime >= PROJECTILE_MIN_CHARGE_SECONDS) {
      const chargeProgress = Math.min(1.0, (chargeTime - PROJECTILE_MIN_CHARGE_SECONDS) / (MAX_CHARGE_TIME - PROJECTILE_MIN_CHARGE_SECONDS));
      speedMultiplier = MIN_SPEED_MULT + chargeProgress * (MAX_SPEED_MULT - MIN_SPEED_MULT);
    }

    // Fire the projectile
    spawnProjectile({ navigationMode, pointerLockActive, viewportInfo, speedMultiplier });

    // Clear indicator
    clearChargeIndicator();
    chargeLevel = 0;
    chargeViewportInfo = null;
  }

  function updateChargeUI() {
    if (!projectilesEnabled || disposeRequested) return;
    if (isCharging) {
      drawChargeIndicator();
    } else if (chargeLevel > 0 || chargeIndicatorNeedsClear) {
      clearChargeIndicator();
      chargeLevel = 0;
    }
  }

  return {
    computePointBoundsFromPositions,
    getPointBoundsRadius() {
      return pointBounds.radius;
    },
    spawn({ navigationMode, pointerLockActive, viewportInfo, speedMultiplier = 1.0 }) {
      spawnProjectile({ navigationMode, pointerLockActive, viewportInfo, speedMultiplier });
    },
    update(dt) {
      if (!projectilesEnabled || disposeRequested) return;
      stepProjectiles(dt);
      updateImpactFlashes(dt);
      if (projectileBufferDirty) rebuildProjectileBuffers();
      if (impactBufferDirty) rebuildImpactBuffers();
    },
    draw(params) {
      if (!projectilesEnabled || disposeRequested) return;
      drawProjectiles(params);
      drawImpactFlashes(params);
    },
    /**
     * Disabling is a pause-and-hide operation: simulation ages, buffer uploads,
     * draw calls, spawning, and charge UI work all stop. Existing projectile
     * and impact state remains owned so a later enable resumes that exact state.
     */
    setEnabled(enabled) {
      const nextEnabled = !!enabled;
      if (nextEnabled && disposeRequested) {
        throw new Error('A disposing projectile system cannot be re-enabled.');
      }
      projectilesEnabled = nextEnabled;
      if (!nextEnabled) cancelCharging();
    },
    reset() {
      projectiles.length = 0;
      impactFlashes.length = 0;
      projectileBufferDirty = true;
      impactBufferDirty = true;
    },
    /**
     * A lost context invalidates every buffer without an explicit WebGL
     * deletion. Publish the same terminal CPU/DOM fence as dispose(), while
     * dropping invalid handles so later viewer disposal remains GL-silent.
     */
    handleContextLost() {
      if (disposed) return false;
      // Publish all terminal CPU/GPU ownership first. Charge-indicator cleanup
      // calls user-controlled canvas methods and may re-enter viewer disposal.
      const needsChargeIndicatorCleanup =
        isCharging || chargeIndicatorNeedsClear;
      disposeRequested = true;
      projectilesEnabled = false;
      projectilePositionBuffer = null;
      projectileColorBuffer = null;
      impactPositionBuffer = null;
      impactColorBuffer = null;
      projectileVao = null;
      impactVao = null;
      centroidProgram = null;
      for (const locations of [
        centroidAttribLocations,
        centroidUniformLocations,
      ]) {
        if (!locations || typeof locations !== 'object') continue;
        for (const key of Object.keys(locations)) {
          locations[key] = null;
        }
      }
      isCharging = false;
      chargeLevel = 0;
      chargeViewportInfo = null;
      chargeIndicatorNeedsClear = false;
      projectiles.length = 0;
      impactFlashes.length = 0;
      projectilePositions = new Float32Array();
      projectileColors = new Uint8Array();
      impactPositions = new Float32Array();
      impactColors = new Uint8Array();
      projectilePointCount = 0;
      contextLossChargeIndicatorNeedsClear =
        needsChargeIndicatorCleanup;
      disposed = true;
      gl = null;
      return true;
    },
    /**
     * Retire the 2D charge indicator only after the viewer has terminalized
     * every GPU owner. Canvas wrappers are user-observable and can re-enter.
     */
    retireContextLostUI() {
      if (!contextLossChargeIndicatorNeedsClear) return false;
      contextLossChargeIndicatorNeedsClear = false;
      clearChargeIndicator(true);
      return true;
    },
    /**
     * Dispose of all WebGL resources to prevent GPU memory leaks.
     * Call this when the projectile system is no longer needed.
     */
    dispose() {
      if (disposed) return false;

      // Fence public work before any fallible cleanup. A failed deletion keeps
      // only that exact handle for the next dispose() attempt.
      disposeRequested = true;
      projectilesEnabled = false;
      const failures = [];
      try {
        cancelCharging();
      } catch (error) {
        failures.push(error);
      }

      const retireBuffer = (buffer, clearOwner) => {
        if (buffer === null) return;
        try {
          gl.deleteBuffer(buffer);
          clearOwner();
        } catch (error) {
          failures.push(error);
        }
      };
      retireBuffer(
        projectilePositionBuffer,
        () => { projectilePositionBuffer = null; }
      );
      retireBuffer(
        projectileColorBuffer,
        () => { projectileColorBuffer = null; }
      );
      retireBuffer(
        impactPositionBuffer,
        () => { impactPositionBuffer = null; }
      );
      retireBuffer(
        impactColorBuffer,
        () => { impactColorBuffer = null; }
      );
      const retireVertexArray = (vao, clearOwner) => {
        if (vao === null) return;
        try {
          gl.deleteVertexArray(vao);
          clearOwner();
        } catch (error) {
          failures.push(error);
        }
      };
      retireVertexArray(projectileVao, () => { projectileVao = null; });
      retireVertexArray(impactVao, () => { impactVao = null; });

      // Logical state is terminal even when a GL handle must be retried.
      isCharging = false;
      chargeLevel = 0;
      chargeViewportInfo = null;
      projectiles.length = 0;
      impactFlashes.length = 0;
      projectilePositions = new Float32Array();
      projectileColors = new Uint8Array();
      impactPositions = new Float32Array();
      impactColors = new Uint8Array();
      projectilePointCount = 0;

      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Projectile disposal failed for ${failures.length} owned resource(s).`
        );
      }
      disposed = true;
      return true;
    },
    // Charge system
    startCharging,
    cancelCharging,
    stopChargingAndFire,
    updateChargeUI,
    isCharging() { return isCharging; },
    /** The pane the current charge was started in, or null. */
    getChargeViewportInfo() { return chargeViewportInfo; },
    /** World positions of the projectiles in flight (copies). */
    getProjectilePositions() {
      return projectiles.map(p => [p.position[0], p.position[1], p.position[2]]);
    },
    /** Whether projectiles, impact flashes, or a charge still change frames. */
    isAnimating() {
      return (
        projectilesEnabled &&
        !disposeRequested &&
        (projectiles.length > 0 || impactFlashes.length > 0 || isCharging)
      );
    },
  };
}
