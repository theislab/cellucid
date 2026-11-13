/**
 * @fileoverview The `camera` state domain: every view's camera, with its
 * navigation mode.
 *
 * Value: `{views: [CameraState, …]}` (live first, then kept views:
 * `view-list.js`), each the viewer's exact camera state
 * (`rendering/camera-state-contract.js`: `{navigationMode, orbit, freefly}`,
 * both representations, as `getViewCameraState` gives them). Views whose
 * cameras are linked report the one camera they share.
 *
 * Restore sets each view whose camera differs (`setViewCameraState`), and
 * the focused one the way a session restore does (its navigation mode, then
 * `setCameraState`, which also stops any glide), so the canvas shows it at
 * once, then checks each view shows the pose it was given (its navigation
 * mode and the half of the camera that mode drives, exactly:
 * `cameraStatesHaveSamePose`); a view that does not is named in the failure.
 * Whether cameras are linked is the `views` domain's.
 *
 * @module app/state/domains/camera
 */

import { cameraStatesHaveSamePose, cloneCameraState } from '../../../rendering/camera-state-contract.js';
import { requireViewsFit, viewIdsOf, viewReadPart } from './view-list.js';
import { viewNameInValue } from '../../actions/targets/views.js';

const MODE_NAMES = Object.freeze({ orbit: 'orbit', planar: 'planar', free: 'free-fly' });

/**
 * @param {{viewer: object, refreshUi: () => void}} options
 */
export function createCameraDomain({ viewer, refreshUi }) {
  return {
    // A step read the view it acted in: staleness compares that view's part alone.
    readPart: viewReadPart,
    capture() {
      return { views: viewIdsOf(viewer).map(id => cloneCameraState(viewer.getViewCameraState(id), `Camera of view "${id}"`)) };
    },
    restore(value) {
      const ids = viewIdsOf(viewer);
      requireViewsFit(value, ids, 'cameras');
      const focused = viewer.getFocusedViewId();
      const liveHidden = viewer.getLiveViewHidden() === true;
      // Every camera is checked before any is set: a value that cannot be put back changes nothing.
      const wantedCameras = ids.map((_id, index) => cloneCameraState(value.views[index], `Camera to restore for ${viewNameInValue(index, liveHidden)}`));
      let changed = false;
      ids.forEach((id, index) => {
        const wanted = wantedCameras[index];
        const current = viewer.getViewCameraState(id);
        if (JSON.stringify(current) === JSON.stringify(wanted)) return;
        changed = true;
        viewer.setViewCameraState(id, wanted);
        if (id === focused) {
          viewer.setNavigationMode(wanted.navigationMode);
          viewer.setCameraState(wanted);
        }
      });
      if (!changed) return;
      refreshUi();
      const missing = ids.flatMap((id, index) => (
        cameraStatesHaveSamePose(viewer.getViewCameraState(id), wantedCameras[index]) ? [] : [viewNameInValue(index, liveHidden)]
      ));
      if (missing.length > 0) {
        throw new Error(`The camera of ${missing.join(', ')} could not be put back where it was.`);
      }
    },
    /** `context.liveHidden`: the live view is hidden at the later value (`views` domain), so the list numbers the kept views from 1; `context.viewLabels`: the views' names there (`viewLabelsInValue`). */
    describe(a, b, { liveHidden = false, viewLabels = null } = {}) {
      const lines = [];
      const count = Math.max(a.views.length, b.views.length);
      for (let v = 0; v < count; v++) {
        const before = a.views[v];
        const after = b.views[v];
        if (before === undefined || after === undefined) continue;
        const prefix = count > 1 ? `${viewNameInValue(v, liveHidden, viewLabels)}: ` : '';
        if (before.navigationMode !== after.navigationMode) {
          lines.push(`${prefix}${MODE_NAMES[after.navigationMode]} navigation`);
        } else if (!cameraStatesHaveSamePose(before, after)) {
          lines.push(`${prefix}camera moved`);
        }
      }
      return lines;
    },
  };
}
