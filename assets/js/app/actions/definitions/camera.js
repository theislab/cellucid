/**
 * @fileoverview Camera actions (each view's camera and navigation mode,
 * resetting it) and camera path actions (keyframes, their timing, playback
 * settings).
 *
 * A camera gesture is recorded by observation: when the viewer says the
 * camera settled (`camera-settled`), one `camera.set` step names the view and
 * the camera it settled at; consecutive camera steps on one view merge into
 * one. Playing a camera path changes nothing but the camera, which is then
 * recorded the same way. A keyframe is named by its label as the Camera path
 * list shows it.
 *
 * The implementations are `app/ui/modules/camera-controls.js` (`camera.set`,
 * `camera.reset`, `camera.navigation.set`, gesture recording),
 * `app/ui/modules/visualization-reset.js` (`display.reset`) and
 * `app/ui/modules/cinematic-camera/index.js` (camera path).
 *
 * @module app/actions/definitions/camera
 */

import { defineAction } from '../catalog.js';
import { EMBEDDING, VIEW } from './params.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';

const CAMERA = 'Camera';
const PATH = 'Camera path';
const VEC3 = Object.freeze({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 });
const NAVIGATION_MODE = Object.freeze({
  enum: ['orbit', 'planar', 'free'],
  description: '"orbit", "planar" or "free" (free-fly).',
});

/** The camera state of `rendering/camera-state-contract.js`: both poses, kept in step. */
export const CAMERA_STATE_PARAM = Object.freeze({
  type: 'object', additionalProperties: false, required: ['navigationMode', 'orbit', 'freefly'],
  description: 'A camera: its navigation mode, and its orbit and free-fly poses (the one the mode drives is used).',
  properties: {
    navigationMode: NAVIGATION_MODE,
    orbit: {
      type: 'object', additionalProperties: false, required: ['radius', 'targetRadius', 'theta', 'phi', 'target'],
      properties: {
        radius: { type: 'number', exclusiveMinimum: 0 },
        targetRadius: { type: 'number', exclusiveMinimum: 0 },
        theta: { type: 'number' },
        phi: { type: 'number' },
        target: VEC3,
      },
    },
    freefly: {
      type: 'object', additionalProperties: false, required: ['position', 'yaw', 'pitch'],
      properties: { position: VEC3, yaw: { type: 'number' }, pitch: { type: 'number' } },
    },
  },
});

const KEYFRAME_PARAM = Object.freeze({
  type: 'string', minLength: 1, pattern: '^\\S(?:.*\\S)?$',
  description: 'A keyframe, by its label as the Camera path list shows it.',
});

const SECONDS = Object.freeze({
  type: ['number', 'null'], minimum: 0.1,
  description: 'Seconds of the transition to the next keyframe, at least 0.1; null paces it automatically.',
});

function secondsText(seconds) {
  return seconds === null ? 'automatic' : `${seconds} s`;
}

export const cameraActions = Object.freeze([
  defineAction({
    type: 'camera.set',
    title: 'Place the camera',
    summary: 'Set the camera of a view (views with linked cameras follow); a camera gesture records one of these.',
    group: CAMERA,
    params: {
      type: 'object', additionalProperties: false, required: ['view', 'camera'],
      properties: { view: VIEW, camera: CAMERA_STATE_PARAM },
    },
    touches: ['camera'],
    // A view by its name (`targets/views.js`).
    reads: [],
    context: ['views'],
    effect: 'view',
    // One gesture, and the gestures that follow on the same view, are one step.
    coalesce: params => params.view,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Moved the camera of ${quote.bare(params.view)}`,
    code: params => `set_camera(${JSON.stringify(params.view)}, <camera>)`,
  }),
  defineAction({
    type: 'camera.reset',
    title: 'Reset the camera',
    summary: 'Put a view\'s camera back to its starting place, keeping its navigation mode (the R key).',
    group: CAMERA,
    params: {
      type: 'object', additionalProperties: false, required: ['view'],
      properties: { view: VIEW },
    },
    touches: ['camera'],
    reads: [],
    context: ['views'],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Reset the camera of ${quote.bare(params.view)}`,
    code: params => `reset_camera(${JSON.stringify(params.view)})`,
  }),
  defineAction({
    type: 'camera.navigation.set',
    title: 'Set the navigation mode',
    summary: 'Navigate a view by orbit, planar or free-fly (O, P and G); views with linked cameras share one mode.',
    group: CAMERA,
    params: {
      type: 'object', additionalProperties: false, required: ['view', 'mode'],
      properties: { view: VIEW, mode: NAVIGATION_MODE },
    },
    touches: ['camera'],
    reads: [],
    context: ['views'],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Navigated ${quote.bare(params.view)} by ${{ orbit: 'orbit', planar: 'planar', free: 'free-fly' }[params.mode]}`,
    code: params => `set_navigation_mode(${JSON.stringify(params.view)}, ${JSON.stringify(params.mode)})`,
  }),
  defineAction({
    type: 'display.reset',
    title: 'Reset the camera and display',
    summary: 'The Reset camera button: the selected view\'s camera, its dimension\'s navigation mode, the background, the render mode and the smoke resolutions back to their defaults.',
    group: CAMERA,
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['camera', 'settings'],
    reads: [],
    context: ['views'],
    effect: 'view',
    describe: () => 'Reset the camera and display',
    code: () => 'reset_display()',
  }),
  defineAction({
    type: 'camera-path.keyframe.add',
    title: 'Add a camera path keyframe',
    summary: 'Save a camera as the next keyframe of the camera path (before the return to start, when there is one).',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        camera: { ...CAMERA_STATE_PARAM, description: 'The camera to save; omitted, the selected view\'s camera now.' },
        label: { ...KEYFRAME_PARAM, description: 'The keyframe\'s label; omitted, "KF n". Unique among the keyframes.' },
        embedding: {
          oneOf: [EMBEDDING, { type: 'null' }],
          description: 'The embedding the keyframe was recorded on; omitted, the one the selected view shows.',
        },
      },
    },
    touches: ['camera-path'],
    // Omitted, the camera and embedding of the view in focus.
    reads: ['camera'],
    context: ['views'],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Saved camera path keyframe ${quote(outcome?.keyframe ?? params.label ?? 'new')}`,
    code: params => `add_keyframe(${params.label === undefined ? '' : JSON.stringify(params.label)})`,
  }),
  defineAction({
    type: 'camera-path.keyframe.remove',
    title: 'Delete a camera path keyframe',
    summary: 'Delete one keyframe of the camera path.',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false, required: ['keyframe'],
      properties: { keyframe: KEYFRAME_PARAM },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Deleted camera path keyframe ${quote(params.keyframe)}`,
    code: params => `remove_keyframe(${JSON.stringify(params.keyframe)})`,
  }),
  defineAction({
    type: 'camera-path.keyframe.move',
    title: 'Move a camera path keyframe',
    summary: 'Move a keyframe one place earlier (up) or later (down) in the camera path.',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false, required: ['keyframe', 'direction'],
      properties: {
        keyframe: KEYFRAME_PARAM,
        direction: { enum: ['up', 'down'], description: '"up" one place earlier, "down" one place later.' },
      },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Moved camera path keyframe ${quote(params.keyframe)} ${params.direction === 'up' ? 'earlier' : 'later'}`,
    code: params => `move_keyframe(${JSON.stringify(params.keyframe)}, ${JSON.stringify(params.direction)})`,
  }),
  defineAction({
    type: 'camera-path.keyframe.rename',
    title: 'Rename a camera path keyframe',
    summary: 'Give a keyframe another label, unique among the keyframes.',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false, required: ['keyframe', 'label'],
      properties: { keyframe: KEYFRAME_PARAM, label: { ...KEYFRAME_PARAM, description: 'The new label.' } },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Renamed camera path keyframe ${quote(params.keyframe)} to ${quote(params.label)}`,
    code: params => `rename_keyframe(${JSON.stringify(params.keyframe)}, ${JSON.stringify(params.label)})`,
  }),
  defineAction({
    type: 'camera-path.duration.set',
    title: 'Set a camera path transition time',
    summary: 'Set how long the camera takes from one keyframe to the next, or from every keyframe to its next.',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false, required: ['seconds'],
      properties: {
        keyframe: { ...KEYFRAME_PARAM, description: 'The keyframe the transition starts at; omitted, every keyframe.' },
        seconds: SECONDS,
      },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (
      params.keyframe === undefined
        ? `Set every camera path transition to ${secondsText(params.seconds)}`
        : `Set the camera path transition after ${quote(params.keyframe)} to ${secondsText(params.seconds)}`
    ),
    code: params => `set_keyframe_duration(${params.keyframe === undefined ? 'None' : JSON.stringify(params.keyframe)}, ${params.seconds === null ? 'None' : params.seconds})`,
  }),
  defineAction({
    type: 'camera-path.loop-back.set',
    title: 'End the camera path at its start',
    summary: 'Add or remove a last keyframe that returns the camera to the first one (two keyframes or more).',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false, required: ['enabled'],
      properties: { enabled: { type: 'boolean', description: 'true to end with the return, false to remove it.' } },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: params => (params.enabled ? 'Ended the camera path with a return to its start' : 'Removed the camera path\'s return to its start'),
    code: params => `set_keyframe_loop_back(${params.enabled ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'camera-path.clear',
    title: 'Clear the camera path',
    summary: 'Delete every keyframe of the camera path; playback stops where the camera is.',
    group: PATH,
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: (params, outcome) => (
      `Cleared the camera path${outcome?.keyframes === undefined ? '' : ` (${formatCountOf(outcome.keyframes, 'keyframe')})`}`
    ),
    code: () => 'clear_camera_path()',
  }),
  defineAction({
    type: 'camera-path.playback.set',
    title: 'Set camera path playback',
    summary: 'Set how the camera path plays: interpolation, easing, speed of automatic transitions, loop and autoplay.',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        position_interpolation: { enum: ['catmull-rom', 'linear', 'bezier'], description: 'How positions between keyframes are drawn.' },
        rotation_interpolation: { enum: ['slerp', 'linear'], description: 'How the view direction turns between keyframes.' },
        easing: { enum: ['linear', 'ease-in-out', 'ease-in', 'ease-out'], description: 'How each transition speeds up and slows down.' },
        speed: { type: 'integer', minimum: 1, maximum: 100, description: 'Speed of automatic transitions, 1 (very slow) to 100 (very fast).' },
        loop: { type: 'boolean', description: 'Play the path again from its start when it ends.' },
        autoplay: { type: 'boolean', description: 'Start playing as soon as the path has two keyframes.' },
      },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    // A speed slider drag is one step; each setting coalesces with itself.
    coalesce: params => Object.keys(params).sort().join(','),
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      // A switch reads on or off, as the panel says it.
      const parts = Object.entries(params).map(([key, value]) => `${key.replaceAll('_', ' ')} ${value === true ? 'on' : value === false ? 'off' : typeof value === 'string' ? quote.bare(value) : value}`);
      return `Set camera path playback: ${parts.length === 0 ? 'unchanged' : parts.join(', ')}`;
    },
    code: params => `set_camera_path_playback(${Object.entries(params).map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value === true ? 'True' : value === false ? 'False' : value}`).join(', ')})`,
  }),
]);
