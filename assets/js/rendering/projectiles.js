/**
 * Projectile system
 * =================
 * Encapsulates all projectile and impact physics + GPU buffers.
 *
 * This module is intentionally stateless w.r.t. viewer internals:
 * everything it needs is passed in via the factory config or via
 * small getter callbacks so that viewer.js owns camera and data.
 */

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
  getFreeflyPosition,
  getFreeflyAxes,
  getCameraParams,
  centroidProgram,
  centroidAttribLocations,
  centroidUniformLocations,
  // For charge indicator
  getLassoCtx,
  getPointerLockActive,
  getNavigationMode,
  // For grid collision
  getGridBounds,
  isGridVisible,
  // For dimension-aware spatial index
  getCurrentDimensionLevel = () => 3,
}) {
  // Projectile buffers (small, dynamic)
  // Color buffers store RGBA as uint8 (alpha packed in)
  const projectilePositionBuffer = gl.createBuffer();
  const projectileColorBuffer = gl.createBuffer(); // RGBA uint8
  const impactPositionBuffer = gl.createBuffer();
  const impactColorBuffer = gl.createBuffer(); // RGBA uint8

  // Projectile sandbox state
  const projectiles = [];
  const impactFlashes = [];
  let projectilesEnabled = false;
  let projectileBufferDirty = true;
  let impactBufferDirty = true;
  let projectilePositions = new Float32Array();
  let projectileColors = new Uint8Array(); // RGBA packed as uint8
  let impactPositions = new Float32Array();
  let impactColors = new Uint8Array(); // RGBA packed as uint8
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

  // Charge system constants
  const MIN_CHARGE_TIME = 0.08;         // Seconds before charge starts building
  const MAX_CHARGE_TIME = 1.0;          // Seconds to reach full charge
  const MIN_SPEED_MULT = 1.0;           // Speed multiplier at min charge
  const MAX_SPEED_MULT = 3.5;           // Speed multiplier at full charge
  const VISUAL_CHARGE_DELAY = 0.2;      // Seconds before indicator appears (quick shots show nothing)

  // Charge system state
  let isCharging = false;
  let chargeStartTime = 0;
  let chargeLevel = 0;
  let chargeViewportInfo = null;

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

  function computePointBoundsFromPositions(positions) {
    if (!positions || positions.length < 3) {
      pointBounds = {
        min: [-1, -1, -1],
        max: [1, 1, 1],
        center: [0, 0, 0],
        radius: 3,
      };
      pointCollisionRadius = 0.02;
      return;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const count = positions.length / 3;
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const x = positions[idx];
      const y = positions[idx + 1];
      const z = positions[idx + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
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
    if (!positionsArray || positionsArray.length < 3) return [];

    // Get the current dimension level and use the appropriate spatial index
    const dimLevel = getCurrentDimensionLevel();
    let spatialIndex = hpRenderer?.getSpatialIndex?.(dimLevel);
    if (!spatialIndex) {
      hpRenderer?.ensureSpatialIndex(dimLevel);
      spatialIndex = hpRenderer?.getSpatialIndex?.(dimLevel);
    }
    if (!spatialIndex) return [];

    // Use the currently displayed LOD level for collision detection
    const currentLOD = hpRenderer.stats?.lodLevel ?? -1;
    const hasLOD = currentLOD >= 0 && spatialIndex.lodLevels?.length > 0;

    if (hasLOD) {
      // Query at the displayed LOD level
      const hits = spatialIndex.queryRadiusAtLOD(center, radius, currentLOD, maxResults);
      return hits.map((hit) => ({
        index: hit.originalIndex,
        position: hit.position,
        color: getNormalizedColor(hit.originalIndex),
      }));
    }

    // Fallback to full resolution query
    const indices = spatialIndex.queryRadius(center, radius, maxResults);
    return indices.map((idx) => {
      const posBase = idx * 3;
      return {
        index: idx,
        position: [
          positionsArray[posBase],
          positionsArray[posBase + 1],
          positionsArray[posBase + 2],
        ],
        color: getNormalizedColor(idx),
      };
    });
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

  // Compute aim direction from cursor screen position (for aiming without pointer lock)
  // viewportInfo: optional { vpWidth, vpHeight, vpOffsetX, vpOffsetY, vpAspect, cameraPosition, cameraAxes }
  function getAimDirectionFromCursor(viewportInfo) {
    const rect = canvas.getBoundingClientRect();
    const cursor = getCursorPosition();

    // Use viewport bounds if provided (for multiview), otherwise use full canvas
    let vpWidth, vpHeight, vpOffsetX, vpOffsetY, aspect;
    if (viewportInfo) {
      vpWidth = viewportInfo.vpWidth;
      vpHeight = viewportInfo.vpHeight;
      vpOffsetX = viewportInfo.vpOffsetX || 0;
      vpOffsetY = viewportInfo.vpOffsetY || 0;
      aspect = viewportInfo.vpAspect || (vpWidth / vpHeight);
    } else {
      vpWidth = rect.width;
      vpHeight = rect.height;
      vpOffsetX = 0;
      vpOffsetY = 0;
      aspect = rect.width / rect.height;
    }

    // Convert cursor position to normalized device coordinates (-1 to 1) relative to viewport
    const localX = cursor.x - rect.left - vpOffsetX;
    const localY = cursor.y - rect.top - vpOffsetY;
    const ndcX = (localX / vpWidth) * 2 - 1;
    const ndcY = -(localY / vpHeight) * 2 + 1;  // Flip Y for GL

    // Create ray in clip space at near plane
    const nearPoint = vec4.set(tempVec4a, ndcX, ndcY, -1, 1);
    const farPoint = vec4.set(tempVec4b, ndcX, ndcY, 1, 1);

    const { fov, near, far } = getCameraParams();

    // Get inverse view-projection matrix
    const tempProj = mat4.create();
    const tempViewProj = mat4.create();
    const invViewProj = mat4.create();
    mat4.perspective(tempProj, fov, aspect, near, far);

    // Build view matrix - use provided camera state for multiview, or global freefly state
    const freeflyPosition = viewportInfo?.cameraPosition || getFreeflyPosition();
    const axes = viewportInfo?.cameraAxes || getFreeflyAxes();
    const { forward: camForward, upVec } = axes;
    const tempView = mat4.create();
    const lookTarget = vec3.add(vec3.create(), freeflyPosition, camForward);
    mat4.lookAt(tempView, freeflyPosition, lookTarget, upVec);

    mat4.multiply(tempViewProj, tempProj, tempView);
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

  // viewportInfo: optional { vpWidth, vpHeight, vpOffsetX, vpOffsetY, vpAspect, cameraPosition, cameraAxes }
  // speedMultiplier: optional speed boost (1.0 = default, higher = faster)
  function spawnProjectile({ navigationMode, pointerLockActive, viewportInfo, speedMultiplier = 1.0 }) {
    if (navigationMode !== 'free') return;
    if (!projectilesEnabled) return;
    const now = performance.now();
    if (now - lastShotTime < SHOT_COOLDOWN_SECONDS * 1000) return;
    lastShotTime = now;

    // Use provided camera state for multiview, or global freefly state
    const axes = viewportInfo?.cameraAxes || getFreeflyAxes();
    const cameraPosition = viewportInfo?.cameraPosition || getFreeflyPosition();

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

  function stepProjectiles(dt) {
    if (!projectiles.length) return;
    const maxRange = pointBounds.radius * 3 + 1.0;
    const collisionRadius = PROJECTILE_RADIUS + pointCollisionRadius;

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

        // Check collisions with cells - use averaged normal for smooth surfaces
        const pointCount = getPointCount();
        const canBounce = p.age - p.lastBounceTime >= COLLISION_COOLDOWN;

        if (pointCount > 0 && !p.resting && canBounce) {
          // Query nearby points around current position
          const hits = queryNearbyPoints(p.position, collisionRadius * 2.0, 48);

          // Find all colliding cells and compute weighted average normal
          let totalWeight = 0;
          const avgNormal = [0, 0, 0];
          let closestHit = null;
          let closestDist = Infinity;

          for (const hit of hits) {
            vec3.sub(tempVec3, p.position, hit.position);
            const d = vec3.length(tempVec3);
            if (d < collisionRadius * 1.2) {
              // Weight by inverse distance - closer cells contribute more
              const weight = 1.0 / Math.max(d, 0.001);
              if (d > 1e-5) {
                avgNormal[0] += (tempVec3[0] / d) * weight;
                avgNormal[1] += (tempVec3[1] / d) * weight;
                avgNormal[2] += (tempVec3[2] / d) * weight;
              }
              totalWeight += weight;

              if (d < closestDist) {
                closestDist = d;
                closestHit = hit;
              }
            }
          }

          if (closestHit && totalWeight > 0) {
            // Normalize the averaged normal
            const nLen = Math.sqrt(avgNormal[0]**2 + avgNormal[1]**2 + avgNormal[2]**2);
            if (nLen > 1e-5) {
              tempVec3[0] = avgNormal[0] / nLen;
              tempVec3[1] = avgNormal[1] / nLen;
              tempVec3[2] = avgNormal[2] / nLen;
            } else {
              // Fallback: use opposite of velocity direction
              vec3.normalize(tempVec3, p.velocity);
              vec3.scale(tempVec3, tempVec3, -1);
            }

            // Ensure normal points away from surface (opposes incoming velocity)
            let vDotN = vec3.dot(p.velocity, tempVec3);
            if (vDotN > 0) {
              vec3.scale(tempVec3, tempVec3, -1);
              vDotN = -vDotN; // Recalculate after flip!
            }

            // Check if moving fast enough to bounce
            const speed = vec3.length(p.velocity);
            if (speed < MIN_BOUNCE_VELOCITY) {
              // Too slow - stop the projectile
              vec3.set(p.velocity, 0, 0, 0);
              p.resting = true;
            } else {
              // Decompose velocity into normal and tangent components
              // vDotN is negative, so tempVec3b points into the surface
              vec3.scale(tempVec3b, tempVec3, vDotN); // Normal component (into surface)
              vec3.sub(tempVec3c, p.velocity, tempVec3b); // Tangent component

              // Reflect and reduce normal component (bounce with energy loss)
              vec3.scale(tempVec3b, tempVec3b, -PROJECTILE_BOUNCE);

              // Reduce tangent component (friction)
              vec3.scale(tempVec3c, tempVec3c, 1.0 - PROJECTILE_FRICTION);

              // Combine for new velocity
              vec3.add(p.velocity, tempVec3b, tempVec3c);

              // Clamp velocity to prevent runaway speeds
              const newSpeed = vec3.length(p.velocity);
              if (newSpeed > MAX_VELOCITY) {
                vec3.scale(p.velocity, p.velocity, MAX_VELOCITY / newSpeed);
              }

              // Push position out of collision cleanly
              const penetration = collisionRadius - closestDist;
              if (penetration > 0) {
                vec3.scaleAndAdd(p.position, p.position, tempVec3, penetration + 0.005);
              }

              // Record bounce time to prevent rapid multi-bounces
              p.lastBounceTime = p.age;
            }

            recordImpact(closestHit.position, closestHit.color || pickProjectileColor());
          }
        }

        // Check collision with grid planes (box bounds)
        if (isGridVisible?.() && !p.resting) {
          const gridBounds = getGridBounds?.();
          if (gridBounds) {
            const { min: gMin, max: gMax } = gridBounds;
            const pos = p.position;
            const vel = p.velocity;
            const radius = PROJECTILE_RADIUS * 0.5; // Smaller collision radius for grid

            // Check each axis for grid plane collision
            // X axis (left/right walls)
            if (pos[0] - radius < gMin && vel[0] < 0) {
              pos[0] = gMin + radius;
              vel[0] = -vel[0] * PROJECTILE_BOUNCE;
              vel[1] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              vel[2] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              p.lastBounceTime = p.age;
            } else if (pos[0] + radius > gMax && vel[0] > 0) {
              pos[0] = gMax - radius;
              vel[0] = -vel[0] * PROJECTILE_BOUNCE;
              vel[1] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              vel[2] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              p.lastBounceTime = p.age;
            }

            // Y axis (floor/ceiling)
            if (pos[1] - radius < gMin && vel[1] < 0) {
              pos[1] = gMin + radius;
              vel[1] = -vel[1] * PROJECTILE_BOUNCE;
              vel[0] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              vel[2] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              p.lastBounceTime = p.age;
            } else if (pos[1] + radius > gMax && vel[1] > 0) {
              pos[1] = gMax - radius;
              vel[1] = -vel[1] * PROJECTILE_BOUNCE;
              vel[0] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              vel[2] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              p.lastBounceTime = p.age;
            }

            // Z axis (front/back walls)
            if (pos[2] - radius < gMin && vel[2] < 0) {
              pos[2] = gMin + radius;
              vel[2] = -vel[2] * PROJECTILE_BOUNCE;
              vel[0] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              vel[1] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              p.lastBounceTime = p.age;
            } else if (pos[2] + radius > gMax && vel[2] > 0) {
              pos[2] = gMax - radius;
              vel[2] = -vel[2] * PROJECTILE_BOUNCE;
              vel[0] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              vel[1] *= (1.0 - PROJECTILE_FRICTION * 0.5);
              p.lastBounceTime = p.age;
            }
          }
        }
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

    projectilePositions = new Float32Array(totalPoints * 3);
    projectileColors = new Uint8Array(totalPoints * 4);
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
    gl.bufferData(gl.ARRAY_BUFFER, projectilePositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, projectileColors, gl.DYNAMIC_DRAW);
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

    impactPositions = new Float32Array(count * 3);
    impactColors = new Uint8Array(count * 4); // RGBA packed
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
    gl.bufferData(gl.ARRAY_BUFFER, impactPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, impactColors, gl.DYNAMIC_DRAW);
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

    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    // Use the same point size as data points so bullets match
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

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

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

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

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // ========== Charge Indicator System ==========

  function drawChargeIndicator() {
    if (!isCharging || getNavigationMode() !== 'free' || !projectilesEnabled) return;

    const lassoCtx = getLassoCtx();
    if (!lassoCtx) return;

    // Update charge level
    const chargeTime = (performance.now() - chargeStartTime) / 1000;
    if (chargeTime < MIN_CHARGE_TIME) {
      chargeLevel = 0;
    } else {
      chargeLevel = Math.min(1.0, (chargeTime - MIN_CHARGE_TIME) / (MAX_CHARGE_TIME - MIN_CHARGE_TIME));
    }

    // Don't show indicator for quick shots - only after holding 200ms+
    if (chargeTime < VISUAL_CHARGE_DELAY) return;

    const rect = canvas.getBoundingClientRect();
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    lassoCtx.scale(dpr, dpr);

    // Get cursor position (use center of screen if in pointer lock)
    let cx, cy;
    if (getPointerLockActive()) {
      cx = rect.width / 2;
      cy = rect.height / 2;
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

  function clearChargeIndicator() {
    const lassoCtx = getLassoCtx();
    if (!lassoCtx) return;
    const rect = canvas.getBoundingClientRect();
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    lassoCtx.scale(dpr, dpr);
    lassoCtx.clearRect(0, 0, rect.width, rect.height);
  }

  function startCharging(viewportInfo) {
    isCharging = true;
    chargeStartTime = performance.now();
    chargeLevel = 0;
    chargeViewportInfo = viewportInfo;
  }

  function cancelCharging() {
    if (isCharging) {
      isCharging = false;
      chargeLevel = 0;
      chargeViewportInfo = null;
      clearChargeIndicator();
    }
  }

  function stopChargingAndFire({ navigationMode, pointerLockActive, viewportInfo }) {
    if (!isCharging) return;

    isCharging = false;
    const chargeTime = (performance.now() - chargeStartTime) / 1000;

    // Calculate speed multiplier based on charge time
    let speedMultiplier = MIN_SPEED_MULT;
    if (chargeTime >= MIN_CHARGE_TIME) {
      const chargeProgress = Math.min(1.0, (chargeTime - MIN_CHARGE_TIME) / (MAX_CHARGE_TIME - MIN_CHARGE_TIME));
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
    if (isCharging) {
      drawChargeIndicator();
    } else if (chargeLevel > 0) {
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
      stepProjectiles(dt);
      updateImpactFlashes(dt);
      if (projectileBufferDirty) rebuildProjectileBuffers();
      if (impactBufferDirty) rebuildImpactBuffers();
    },
    draw({
      viewportHeight,
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      basePointSize,
      sizeAttenuation,
      fov,
    }) {
      drawProjectiles({
        viewportHeight,
        mvpMatrix,
        viewMatrix,
        modelMatrix,
        basePointSize,
        sizeAttenuation,
        fov,
      });
      drawImpactFlashes({
        viewportHeight,
        mvpMatrix,
        viewMatrix,
        modelMatrix,
        basePointSize,
        sizeAttenuation,
        fov,
      });
    },
    setEnabled(enabled) {
      projectilesEnabled = !!enabled;
    },
    reset() {
      projectiles.length = 0;
      impactFlashes.length = 0;
      projectileBufferDirty = true;
      impactBufferDirty = true;
    },
    /**
     * Dispose of all WebGL resources to prevent GPU memory leaks.
     * Call this when the projectile system is no longer needed.
     */
    dispose() {
      // Delete all WebGL buffers
      if (projectilePositionBuffer) gl.deleteBuffer(projectilePositionBuffer);
      if (projectileColorBuffer) gl.deleteBuffer(projectileColorBuffer);
      if (impactPositionBuffer) gl.deleteBuffer(impactPositionBuffer);
      if (impactColorBuffer) gl.deleteBuffer(impactColorBuffer);

      // Clear state
      projectiles.length = 0;
      impactFlashes.length = 0;
      projectilePositions = new Float32Array();
      projectileColors = new Uint8Array();
      impactPositions = new Float32Array();
      impactColors = new Uint8Array();
      projectilePointCount = 0;

      console.log('[Projectiles] WebGL resources disposed');
    },
    // Charge system
    startCharging,
    cancelCharging,
    stopChargingAndFire,
    updateChargeUI,
    isCharging() { return isCharging; },
  };
}

