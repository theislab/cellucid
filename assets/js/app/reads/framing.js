/**
 * @fileoverview Where cells sit in a view, and cameras that frame them
 * (`camera.framing`, `app/actions/definitions/camera.js`): what an agent
 * directing a camera path needs to compose a shot ("the beta cells, filling
 * the frame, seen from the side") without guessing coordinates from pictures.
 *
 * Positions are the ones the view draws (`viewer.withBorrowedViewData`): the
 * embedding normalized to about -1..1, the coordinates every camera of the
 * view is in. Only the cells the view shows count (its filters and hidden
 * categories). A group is summarized by its mean and spread (standard
 * deviation along each axis), never by one cell's coordinate, so the read is
 * a summary of groups (`agent/bridge/data-guard.js`).
 *
 * A camera frames a group by the spread of its cells across the view, seen
 * from the direction asked for: its target is the group's center, its
 * distance makes ±1.8 standard deviations of the group fill `fill` of the
 * frame across and up (the frame's own shape and field of view,
 * `rendering/viewer/field-of-view.js`), with half the group's depth toward
 * the camera in front of that. A 3D view is framed by an orbit camera
 * from an azimuth and elevation (the view's own when not given); 1D and 2D
 * views by a planar camera, looking at the x–y plane.
 *
 * @module app/reads/framing
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { FieldKind } from '../utils/field-constants.js';
import { missingCategoryCode } from '../../data/categorical-storage-contract.js';
import { categoryDisplayName, listNames, quoteName } from '../actions/targets/names.js';
import { resolveCategory, resolveField } from '../actions/targets/fields.js';
import { resolveViewName, viewNameOf } from '../actions/targets/views.js';
import { cameraStateForOrbitPose } from '../../rendering/camera-state-contract.js';
import { NO_DATASET_OPEN } from '../ui/no-dataset.js';

/**
 * Standard deviations either side of a group's center that the frame holds:
 * 1.8 holds about 93% of a normal group and all of a uniform one (whose
 * half-width is 1.73 standard deviations).
 */
const SPREAD_FRAMED = 1.8;
/** The share of a group a shot keeps in the frame, and how a shot that cuts more moves back (at most 4 times). */
const KEPT_IN_FRAME = 0.97;
const MOVE_BACK = 1.12;
const MOVES_BACK = 4;
/** The nearest an orbit camera comes to its target, and the farthest (`viewer.js`). */
const NEAREST = 0.05;
const FARTHEST = 100;
/** Elevations stop short of straight above or below, where an orbit camera has no up. */
const STEEPEST_DEGREES = 85;
const DEG = Math.PI / 180;

/** A number to four decimals: what a camera needs, without float noise. */
const round = value => Math.round(value * 1e4) / 1e4;

/** Running sums of a group's positions: count, Σp, Σpp (xx, xy, xz, yy, yz, zz). */
function moments() {
  return { n: 0, s: [0, 0, 0], ss: [0, 0, 0, 0, 0, 0] };
}

function add(m, x, y, z) {
  m.n++;
  m.s[0] += x; m.s[1] += y; m.s[2] += z;
  m.ss[0] += x * x; m.ss[1] += x * y; m.ss[2] += x * z;
  m.ss[3] += y * y; m.ss[4] += y * z; m.ss[5] += z * z;
}

/** Center and covariance of a group with at least one cell. */
function centerAndCovariance(m) {
  const c = m.s.map(value => value / m.n);
  // E[pp] - E[p]E[p]; a variance rounded below zero is zero.
  const co = (k, a, b) => m.ss[k] / m.n - c[a] * c[b];
  const variance = (k, a) => Math.max(0, co(k, a, a));
  const xy = co(1, 0, 1);
  const xz = co(2, 0, 2);
  const yz = co(4, 1, 2);
  return {
    center: c,
    cov: [
      [variance(0, 0), xy, xz],
      [xy, variance(3, 1), yz],
      [xz, yz, variance(5, 2)],
    ],
  };
}

/** The standard deviation of a group along the unit vector `v`. */
function spreadAlong(cov, v) {
  let sum = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) sum += v[a] * cov[a][b] * v[b];
  return Math.sqrt(Math.max(0, sum));
}

/**
 * The camera's axes for a direction: `toward` from the target to the eye
 * (orbit convention), `right` and `up` across the frame.
 */
function axesOf(mode, theta, phi) {
  if (mode === 'planar') return { toward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] };
  const toward = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
  // right = forward × worldUp, with forward = -toward; up = right × forward.
  const forward = toward.map(value => -value);
  let right = [-forward[2], 0, forward[0]];
  const length = Math.hypot(right[0], right[2]);
  right = [right[0] / length, 0, right[2] / length];
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { toward, right, up };
}

/**
 * @param {{state: object, viewer: object}} owners
 */
export function createFramingReads({ state, viewer }) {
  /** The frame's tangents of its half-angles across (x) and up (y), for the view's pane. */
  function frameOf(viewId) {
    const layout = viewer.getPresentedLayout?.() ?? null;
    const pane = layout?.panes?.find(each => each.viewId === viewId) ?? null;
    // The pane's own field of view: a grid's portrait panes see wider across.
    const fov = pane?.fov ?? viewer.getCameraParams().fov;
    const width = pane?.visibleCssWidth ?? layout?.presentedArea?.cssWidth ?? 4;
    const height = pane?.visibleCssHeight ?? layout?.presentedArea?.cssHeight ?? 3;
    const tanY = Math.tan(fov / 2);
    return { tanX: tanY * (width / height), tanY, aspect: width / height };
  }

  /**
   * A first pose framing a group (module overview), from its spread on
   * either side of its mean across and up the frame (the root mean square
   * of the cells' distances from the mean on that side), so a lopsided group
   * starts near its middle. `refinePoses` then corrects it in perspective.
   */
  function initialPose(group, sides, axes, mode, frame, fill) {
    const { center, cov } = centerAndCovariance(group);
    const { toward, right, up } = axes;
    const [rightward, leftward, upward, downward] = [sides.rp, sides.rn, sides.up, sides.un].map(side => SPREAD_FRAMED * side);
    const shiftAcross = (rightward - leftward) / 2;
    const shiftUp = (upward - downward) / 2;
    const across = (rightward + leftward) / 2;
    const tall = (upward + downward) / 2;
    const depth = mode === 'planar' ? 0 : SPREAD_FRAMED * spreadAlong(cov, toward);
    const radius = clampRadius(Math.max(across / frame.tanX, tall / frame.tanY) / fill + depth / 2, depth);
    const target = center.map((value, axis) => value + right[axis] * shiftAcross + up[axis] * shiftUp);
    return { target, radius };
  }

  function clampRadius(radius, depth) {
    return Math.min(FARTHEST, Math.max(NEAREST + depth / 2, radius));
  }

  /** What `camera.framing` says of a framed group: its cells, center and extent, and the camera. */
  function framed(group, pose, mode, theta, phi) {
    const { center, cov } = centerAndCovariance(group);
    const camera = cameraStateForOrbitPose({
      navigationMode: mode, target: pose.target.map(round), radius: round(pose.radius), theta: round(theta), phi: round(phi),
    });
    camera.freefly.position = camera.freefly.position.map(round);
    camera.freefly.yaw = round(camera.freefly.yaw);
    camera.freefly.pitch = round(camera.freefly.pitch);
    // The extent said: two standard deviations (about 95% of a compact group).
    const extent = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => round(2 * spreadAlong(cov, axis)));
    return {
      cells: group.n,
      center: center.map(round),
      extent,
      camera,
      foreground: Math.round(pose.foreground * 100) / 100,
      nearest: Math.round(pose.nearest * 100) / 100,
    };
  }

  async function framing({ view, field: ref, categories, azimuth, elevation, fill }, { signal }) {
    if (!(state.pointCount > 0)) throw new ActionRefused(NO_DATASET_OPEN, { code: 'unavailable' });
    const viewId = view === undefined ? state.getActiveViewId() : resolveViewName(viewer, view);
    if (categories !== undefined && ref === undefined) {
      throw new ActionRefused('Categories are named with the field they belong to: give field too.', { code: 'refused' });
    }
    let field = null;
    let wanted = null;
    if (ref !== undefined) {
      const target = resolveField(state, ref, { kind: FieldKind.CATEGORY });
      await state.ensureFieldLoaded(target.index, { silent: true, signal });
      field = resolveField(state, ref, { kind: FieldKind.CATEGORY }).field;
      wanted = categories === undefined ? null : new Set(categories.map(label => resolveCategory(field, label)));
    }

    const current = viewer.getViewCameraState(viewId);
    const embedding = state.describeViewEmbedding?.(viewId) ?? null;
    const frame = frameOf(viewId);

    // The cells the view shows, in groups: the whole view (slot 0), the
    // categories named together (slot 1), each category (slot 2 + code).
    const categoryCount = field === null ? 0 : field.categories.length;
    const slotCount = 2 + categoryCount;
    const { mode, theta, phi, elevationDegrees, slots, poses } = viewer.withBorrowedViewData(viewId, data => {
      const positions = data.positions;
      // A view's positions hold as many coordinates per cell as it has
      // dimensions (x; x, y; x, y, z); a missing one is 0.
      const stride = positions.length / data.pointCount;
      const coord = (i, axis) => (axis < stride ? positions[i * stride + axis] : 0);
      const alpha = data.transparency;
      const codes = field?.codes ?? null;
      const missing = codes === null ? -1 : missingCategoryCode(codes);
      const shown = i => alpha === null || alpha === undefined || alpha[i] > 0;
      // The slots a cell counts in, written into `into`; returns how many.
      const into = new Int32Array(3);
      const slotsOf = i => {
        into[0] = 0;
        let count = 1;
        if (codes !== null) {
          const code = codes[i];
          if (code !== missing && code < categoryCount) {
            into[count++] = 2 + code;
            if (wanted !== null && wanted.has(code)) into[count++] = 1;
          }
        }
        return count;
      };

      const moment = Array.from({ length: slotCount }, () => moments());
      for (let i = 0; i < data.pointCount; i++) {
        if (!shown(i)) continue;
        const x = coord(i, 0);
        const y = coord(i, 1);
        const z = coord(i, 2);
        const count = slotsOf(i);
        for (let k = 0; k < count; k++) add(moment[into[k]], x, y, z);
      }

      const navigation = data.dimensionLevel >= 3 ? 'orbit' : 'planar';
      // The direction: the one asked for, else the view's own (orbit
      // convention). A planar camera always faces the x–y plane.
      const azimuthRadians = azimuth === undefined ? current.orbit.theta : azimuth * DEG;
      const elevated = Math.max(-STEEPEST_DEGREES, Math.min(STEEPEST_DEGREES,
        elevation === undefined ? 90 - current.orbit.phi / DEG : elevation));
      const polar = (90 - elevated) * DEG;
      const frameAxes = axesOf(navigation, azimuthRadians, polar);

      // Each group's spread on either side of its mean, across and up the frame.
      const across = frameAxes.right;
      const upward = frameAxes.up;
      const meanAcross = moment.map(m => (m.n === 0 ? 0 : (m.s[0] * across[0] + m.s[1] * across[1] + m.s[2] * across[2]) / m.n));
      const meanUp = moment.map(m => (m.n === 0 ? 0 : (m.s[0] * upward[0] + m.s[1] * upward[1] + m.s[2] * upward[2]) / m.n));
      // Per slot: Σd² and count of cells right of, left of, above, below the mean.
      const tally = Array.from({ length: slotCount }, () => new Float64Array(8));
      for (let i = 0; i < data.pointCount; i++) {
        if (!shown(i)) continue;
        const x = coord(i, 0);
        const y = coord(i, 1);
        const z = coord(i, 2);
        const a = x * across[0] + y * across[1] + z * across[2];
        const u = x * upward[0] + y * upward[1] + z * upward[2];
        const count = slotsOf(i);
        for (let k = 0; k < count; k++) {
          const slot = into[k];
          const t = tally[slot];
          const da = a - meanAcross[slot];
          const du = u - meanUp[slot];
          if (da >= 0) { t[0] += da * da; t[1]++; } else { t[2] += da * da; t[3]++; }
          if (du >= 0) { t[4] += du * du; t[5]++; } else { t[6] += du * du; t[7]++; }
        }
      }
      const rms = (sum, n) => (n === 0 ? 0 : Math.sqrt(sum / n));
      const sideSpreads = tally.map(t => ({ rp: rms(t[0], t[1]), rn: rms(t[2], t[3]), up: rms(t[4], t[5]), un: rms(t[6], t[7]) }));
      const poses = moment.map((m, slot) => (m.n === 0 ? null : initialPose(m, sideSpreads[slot], frameAxes, navigation, frame, fill)));

      // In perspective the near cells look larger and further out than the
      // far ones: measure each group as the camera would see it (its spread
      // on either side across and up the frame, in fractions of the half
      // frame) and move and scale the camera until it is centered and fills
      // `fill` of the frame (three corrections settle it within a few %).
      // Then nothing important is cut: a group with long arms (a whole
      // embedding) is moved back until all but 3% of it is in the frame.
      const { right: r, up: u, toward: w } = frameAxes;
      const settled = new Uint8Array(slotCount);
      for (let pass = 0; pass < 3 + MOVES_BACK; pass++) {
        const sums = Array.from({ length: slotCount }, () => new Float64Array(3));
        const project = (slot, x, y, z, out) => {
          const pose = poses[slot];
          const ex = pose.target[0] + w[0] * pose.radius;
          const ey = pose.target[1] + w[1] * pose.radius;
          const ez = pose.target[2] + w[2] * pose.radius;
          const qx = x - ex;
          const qy = y - ey;
          const qz = z - ez;
          const ahead = -(qx * w[0] + qy * w[1] + qz * w[2]);
          if (!(ahead > NEAREST / 2)) return false;
          out[0] = (qx * r[0] + qy * r[1] + qz * r[2]) / (ahead * frame.tanX);
          out[1] = (qx * u[0] + qy * u[1] + qz * u[2]) / (ahead * frame.tanY);
          return true;
        };
        const at = new Float64Array(2);
        for (let i = 0; i < data.pointCount; i++) {
          if (!shown(i)) continue;
          const count = slotsOf(i);
          for (let k = 0; k < count; k++) {
            const slot = into[k];
            if (!project(slot, coord(i, 0), coord(i, 1), coord(i, 2), at)) continue;
            const sum = sums[slot];
            sum[0] += at[0]; sum[1] += at[1]; sum[2]++;
          }
        }
        const spread = Array.from({ length: slotCount }, () => new Float64Array(8));
        const inside = new Float64Array(slotCount);
        for (let i = 0; i < data.pointCount; i++) {
          if (!shown(i)) continue;
          const count = slotsOf(i);
          for (let k = 0; k < count; k++) {
            const slot = into[k];
            if (sums[slot][2] === 0 || !project(slot, coord(i, 0), coord(i, 1), coord(i, 2), at)) continue;
            const t = spread[slot];
            const dx = at[0] - sums[slot][0] / sums[slot][2];
            const dy = at[1] - sums[slot][1] / sums[slot][2];
            if (dx >= 0) { t[0] += dx * dx; t[1]++; } else { t[2] += dx * dx; t[3]++; }
            if (dy >= 0) { t[4] += dy * dy; t[5]++; } else { t[6] += dy * dy; t[7]++; }
            if (Math.abs(at[0]) <= 1 && Math.abs(at[1]) <= 1) inside[slot]++;
          }
        }
        poses.forEach((pose, slot) => {
          if (pose === null || sums[slot][2] === 0 || settled[slot] === 1) return;
          if (pass >= 3) {
            if (inside[slot] >= KEPT_IN_FRAME * moment[slot].n) settled[slot] = 1;
            else pose.radius = clampRadius(pose.radius * MOVE_BACK, 0);
            return;
          }
          const t = spread[slot];
          const meanX = sums[slot][0] / sums[slot][2];
          const meanY = sums[slot][1] / sums[slot][2];
          const [px, nx, py, ny] = [rms(t[0], t[1]), rms(t[2], t[3]), rms(t[4], t[5]), rms(t[6], t[7])].map(side => SPREAD_FRAMED * side);
          const centerX = meanX + (px - nx) / 2;
          const centerY = meanY + (py - ny) / 2;
          const size = Math.max((px + nx) / 2, (py + ny) / 2);
          // The shift that centers it, at the target's distance; the
          // distance that makes it fill `fill` (its size goes as 1/distance).
          for (let axis = 0; axis < 3; axis++) {
            pose.target[axis] += r[axis] * centerX * pose.radius * frame.tanX + u[axis] * centerY * pose.radius * frame.tanY;
          }
          if (size > 0) pose.radius = clampRadius(pose.radius * size / fill, 0);
        });
      }
      // What stands between each camera and its subject: the other shown
      // cells nearer than the target that the frame shows (a shot through
      // another population), and how near the nearest cell comes (cells
      // much nearer than the subject look large: a ball pit).
      const foreground = new Float64Array(slotCount);
      const nearest = new Float64Array(slotCount).fill(Infinity);
      const eyes = poses.map(pose => (pose === null ? null : pose.target.map((value, axis) => value + w[axis] * pose.radius)));
      const member = new Uint8Array(slotCount);
      for (let i = 0; i < data.pointCount; i++) {
        if (!shown(i)) continue;
        const count = slotsOf(i);
        for (let k = 0; k < count; k++) member[into[k]] = 1;
        const x = coord(i, 0);
        const y = coord(i, 1);
        const z = coord(i, 2);
        for (let slot = 0; slot < slotCount; slot++) {
          const eye = eyes[slot];
          if (eye === null) continue;
          const qx = x - eye[0];
          const qy = y - eye[1];
          const qz = z - eye[2];
          const ahead = -(qx * w[0] + qy * w[1] + qz * w[2]);
          if (ahead <= 0) continue;
          const distance = Math.sqrt(qx * qx + qy * qy + qz * qz);
          if (distance < nearest[slot]) nearest[slot] = distance;
          if (member[slot] === 1 || ahead >= poses[slot].radius) continue;
          const sx = (qx * r[0] + qy * r[1] + qz * r[2]) / (ahead * frame.tanX);
          const sy = (qx * u[0] + qy * u[1] + qz * u[2]) / (ahead * frame.tanY);
          if (Math.abs(sx) <= 1 && Math.abs(sy) <= 1) foreground[slot]++;
        }
        for (let k = 0; k < count; k++) member[into[k]] = 0;
      }
      poses.forEach((pose, slot) => {
        if (pose === null) return;
        pose.foreground = moment[slot].n === 0 ? 0 : foreground[slot] / moment[slot].n;
        pose.nearest = Number.isFinite(nearest[slot]) ? nearest[slot] / pose.radius : 1;
      });
      return {
        mode: navigation,
        theta: azimuthRadians,
        phi: polar,
        elevationDegrees: elevated,
        slots: moment,
        poses,
      };
    });
    const whole = slots[0];
    const frameSlot = slot => framed(slots[slot], poses[slot], mode, theta, phi);

    const groups = [];
    const notShown = [];
    if (field !== null) {
      field.categories.forEach((label, code) => {
        if (wanted !== null && !wanted.has(code)) return;
        if (slots[2 + code].n === 0) {
          notShown.push(categoryDisplayName(label));
          return;
        }
        groups.push({ label: categoryDisplayName(label), ...frameSlot(2 + code) });
      });
    }
    if (whole.n === 0) {
      throw new ActionRefused(`${viewNameOf(viewer, viewId)} shows no cells: its filters or hidden categories leave none.`, { code: 'refused' });
    }
    if (wanted !== null && groups.length === 0) {
      throw new ActionRefused(
        `${listNames(notShown)} ${notShown.length === 1 ? 'has' : 'have'} no cells shown in ${viewNameOf(viewer, viewId)}; ${quoteName(field.key)} is filtered or hidden there.`,
        { code: 'refused' },
      );
    }
    return {
      view: viewNameOf(viewer, viewId),
      embedding: embedding === null ? null : { name: embedding.name, dimension: embedding.dimension },
      navigation: mode,
      direction: mode === 'orbit' ? { azimuth: round(theta / DEG), elevation: round(elevationDegrees) } : null,
      frame: { aspect: round(frame.aspect), vertical_view_degrees: round(2 * Math.atan(frame.tanY) / DEG), fill },
      ...(wanted !== null ? { together: frameSlot(1) } : {}),
      whole: frameSlot(0),
      ...(field !== null ? { field: field.key, groups, not_shown: notShown } : {}),
    };
  }

  return { framing };
}
