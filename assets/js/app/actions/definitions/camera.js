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
import { CATEGORY_FIELD, CATEGORY_LABEL, EMBEDDING, TRIMMED_NAME, VIEW } from './params.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { viewWords } from '../targets/views.js';

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
  description: 'A camera: its navigation mode, and its orbit and free-fly poses (the one the mode drives is used). Coordinates are the view\'s (the embedding scaled to about -1..1, y up); an orbit camera sits at target + radius·(sin phi·cos theta, cos phi, sin phi·sin theta) looking at target (theta the azimuth, phi from straight above, radians); a planar one at target + (0, 0, radius). Take cameras from `camera_framing` rather than composing them.',
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

/** Cells framed by `camera.framing`: how many, their center and spread, and the camera. */
const FRAMED = Object.freeze({
  type: 'object', additionalProperties: false, required: ['cells', 'center', 'extent', 'camera', 'foreground', 'nearest'],
  properties: {
    cells: { type: 'integer', minimum: 1, description: 'Cells the view shows of it.' },
    center: { ...VEC3, description: 'Its mean position.' },
    extent: { ...VEC3, description: 'Twice its standard deviation along x, y and z (about 95% of a compact group lies within center ± extent).' },
    camera: CAMERA_STATE_PARAM,
    foreground: { type: 'number', minimum: 0, description: 'Other cells in front of it in that shot, per cell of its own: 0 a clear view; above about 0.3 the shot looks through another population (try another direction).' },
    nearest: { type: 'number', minimum: 0, description: 'The nearest cell\'s distance from the camera divided by the camera\'s distance to its target: near 1, nothing comes nearer than the subject (good); below about 0.3, cells pass close to the lens and look large (fill less, or another direction).' },
  },
});

const KEYFRAME_PARAM = Object.freeze({
  type: 'string', minLength: 1, pattern: TRIMMED_NAME,
  description: 'A keyframe, by its label as the Camera path list shows it.',
});

const SECONDS = Object.freeze({
  type: ['number', 'null'], minimum: 0.1,
  description: 'Seconds of the transition to the next keyframe, at least 0.1; null paces it automatically.',
});

function secondsText(seconds) {
  return seconds === null ? 'automatic' : `${seconds} s`;
}

/** A keyframe's hold: the seconds the camera rests there before moving on. */
const HOLD = Object.freeze({
  type: 'number', minimum: 0,
  description: 'Seconds the camera rests at the keyframe before moving on (a pause in the shot); 0 for none.',
});

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
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Moved the camera of ${viewWords(params.view, outcome?.label, quote)}`,
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
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Reset the camera of ${viewWords(params.view, outcome?.label, quote)}`,
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
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Navigated ${viewWords(params.view, outcome?.label, quote)} by ${{ orbit: 'orbit', planar: 'planar', free: 'free-fly' }[params.mode]}`,
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
    summary: 'Save a camera as the next keyframe of the camera path (before the return to start, when there is one), optionally with a hold: seconds the camera rests there.',
    group: PATH,
    // Version 2 adds the hold; a version 1 keyframe held none, which is a hold of 0.
    version: 2,
    upgrade: { 1: params => params },
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        camera: { ...CAMERA_STATE_PARAM, description: 'The camera to save, whole (one from camera_framing or views_state); omitted, the selected view\'s camera now.' },
        label: { ...KEYFRAME_PARAM, description: 'The keyframe\'s label, the shot\'s name: in the Camera path list, and, while the path plays with captions on (the default), its caption over the plot from halfway into the move to it until halfway out of it, as a documentary\'s title ("Beta cells", "Overview"; short, a title case phrase). Omitted, "KF n", which is never captioned. Unique among the keyframes.' },
        embedding: {
          oneOf: [EMBEDDING, { type: 'null' }],
          description: 'The embedding the keyframe was recorded on; omitted, the one the selected view shows.',
        },
        hold: { ...HOLD, description: 'Seconds the camera rests at the keyframe before moving on; omitted, 0 (none).' },
      },
    },
    touches: ['camera-path'],
    // Omitted, the camera and embedding of the view in focus.
    reads: ['camera'],
    // The keyframe holds the camera it was saved at: moving on never makes it stale.
    captures: ['camera'],
    context: ['views'],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Saved camera path keyframe ${quote(outcome?.keyframe ?? params.label ?? 'new')}${params.hold > 0 ? `, held ${secondsText(params.hold)}` : ''}`,
    code: params => `add_keyframe(${[
      ...(params.label === undefined ? [] : [JSON.stringify(params.label)]),
      ...(params.hold === undefined ? [] : [`hold=${params.hold}`]),
    ].join(', ')})`,
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
      properties: { keyframe: KEYFRAME_PARAM, label: { ...KEYFRAME_PARAM, description: 'The new label: the shot\'s name, and its caption while the path plays with captions on.' } },
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
    type: 'camera-path.hold.set',
    title: 'Set a camera path hold',
    summary: 'Set how long the camera rests at one keyframe, or at every keyframe, before moving on (0 for no rest). The path grows by the hold; each transition keeps its time.',
    group: PATH,
    params: {
      type: 'object', additionalProperties: false, required: ['seconds'],
      properties: {
        keyframe: { ...KEYFRAME_PARAM, description: 'The keyframe the camera rests at; omitted, every keyframe.' },
        seconds: HOLD,
      },
    },
    touches: ['camera-path'],
    reads: [],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (
      params.keyframe === undefined
        ? (params.seconds === 0 ? 'Removed every camera path hold' : `Held every camera path keyframe ${secondsText(params.seconds)}`)
        : (params.seconds === 0 ? `Removed the hold at ${quote(params.keyframe)}` : `Held camera path keyframe ${quote(params.keyframe)} ${secondsText(params.seconds)}`)
    ),
    code: params => `set_keyframe_hold(${params.keyframe === undefined ? 'None' : JSON.stringify(params.keyframe)}, ${params.seconds})`,
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
    summary: 'Set how the camera path plays: interpolation, easing, speed of automatic transitions, loop, autoplay and captions.',
    group: PATH,
    // Version 2 adds `captions` (F110); a version 1 step names none.
    version: 2,
    upgrade: { 1: params => params },
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        position_interpolation: { enum: ['catmull-rom', 'linear', 'bezier'], description: 'How positions between keyframes are drawn: catmull-rom is the smooth one (no jolt or overshoot at a keyframe; a keyframe repeated is a hold).' },
        rotation_interpolation: { enum: ['slerp', 'linear'], description: 'How the view direction turns between keyframes.' },
        easing: { enum: ['linear', 'ease-in-out', 'ease-in', 'ease-out'], description: 'How the path starts and ends: from rest and to rest (ease-in-out), from rest (ease-in), to rest (ease-out), or moving (linear); every transition keeps its own time.' },
        speed: { type: 'integer', minimum: 1, maximum: 100, description: 'Speed of automatic transitions, 1 (very slow) to 100 (very fast).' },
        loop: { type: 'boolean', description: 'Play the path again from its start when it ends.' },
        autoplay: { type: 'boolean', description: 'Start playing as soon as the path has two keyframes.' },
        captions: { type: 'boolean', description: 'Show each named keyframe\'s label as a caption over the plot while the path plays (on by default; a keyframe still called "KF n" has none).' },
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
  defineAction({
    type: 'camera-path.play',
    title: 'Play the camera path',
    summary: 'Play the camera path in the selected view from its first keyframe, as Play does; answers when it ends or camera_path_stop or the person\'s Stop stops it (the camera stays where it stopped; a looping path plays on until stopped, by camera_path_stop or the person\'s Stop of this turn), with ended "end", "stopped", "looping" or "reduced-motion": the person\'s system asks for reduced motion, so the camera went to the last keyframe without moving (seconds: how long it moved, 0 when at once); nothing played, so never describe a film that ran.',
    group: PATH,
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['camera'],
    // The camera it ends at is the path's last keyframe; it holds that itself.
    reads: ['camera-path'],
    captures: ['camera-path'],
    context: ['views'],
    effect: 'view',
    // The person's Stop of the turn stops the film where it is, as a pause
    // does, and the step keeps that camera (F104).
    keepsWhenStopped: true,
    describe: (params, outcome) => (
      outcome?.ended === 'stopped'
        ? 'Played the camera path (stopped before its end)'
        : outcome?.ended === 'looping'
          ? 'Played the camera path on a loop'
          : outcome?.ended === 'reduced-motion'
            ? 'Went to the end of the camera path at once (reduced motion)'
            : 'Played the camera path'
    ),
    code: () => 'play_camera_path()',
  }),
  defineAction({
    type: 'camera-path.stop',
    title: 'Stop the camera path',
    summary: 'Stop a playing camera path where the camera is, at once, also while camera_path_play is still waiting for it to end (that play then answers ended "stopped", and its step holds the camera where it stopped).',
    group: PATH,
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    // Stepless, so it never waits behind the play it stops (catalog.js `isSteplessEffect`).
    effect: 'control',
    result: {
      type: 'object', additionalProperties: false, required: ['stopped'],
      properties: { stopped: { type: 'boolean', description: 'False when no camera path was playing.' } },
    },
    describe: () => 'Stopped the camera path',
    code: () => 'stop_camera_path()',
  }),
  defineAction({
    type: 'camera-path.get',
    title: 'Read the camera path',
    summary: 'The camera path: each keyframe (label, camera, when it is reached, how long the camera rests there, the time of the transition after it), how it plays, its length, and whether it is playing.',
    group: PATH,
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['keyframes', 'seconds', 'playing', 'return_to_start', 'playback'],
      properties: {
        keyframes: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['label', 'at', 'hold', 'seconds', 'automatic', 'camera', 'embedding'],
            properties: {
              label: { type: 'string' },
              at: { type: 'number', description: 'Seconds from the start when the camera reaches it.' },
              hold: { type: 'number', description: 'Seconds the camera rests there before moving on (0 for none).' },
              seconds: { type: ['number', 'null'], description: 'Seconds of the transition to the next keyframe (null for the last).' },
              automatic: { type: 'boolean', description: 'The transition is paced by the speed setting, not set.' },
              camera: CAMERA_STATE_PARAM,
              embedding: { oneOf: [EMBEDDING, { type: 'null' }] },
            },
          },
        },
        seconds: { type: 'number', description: 'The whole path\'s length in seconds, holds included.' },
        playing: { enum: ['playing', 'paused', 'stopped'] },
        return_to_start: { type: 'boolean', description: 'Ends with a return to the first keyframe.' },
        playback: {
          type: 'object', additionalProperties: false,
          required: ['position_interpolation', 'rotation_interpolation', 'easing', 'speed', 'loop', 'autoplay', 'captions'],
          properties: {
            position_interpolation: { type: 'string' }, rotation_interpolation: { type: 'string' }, easing: { type: 'string' },
            speed: { type: 'integer' }, loop: { type: 'boolean' }, autoplay: { type: 'boolean' },
            captions: { type: 'boolean', description: 'Named keyframes show their labels as captions while the path plays.' },
          },
        },
      },
    },
    describe: () => 'Read the camera path',
    code: () => 'camera_path()',
  }),
  defineAction({
    type: 'camera.framing',
    title: 'Frame cells with the camera',
    summary: 'Where cells sit in a view and cameras that frame them, seen from a direction: the whole view, each category of a field (or those named), and those named together. Nothing moves; give a camera to camera_set or camera_path_keyframe_add. It frames the view as it is laid out now (side by side, a view is narrower): arrange the views first.',
    group: CAMERA,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        view: { ...VIEW, description: 'The view: "View N" as the Compare views list numbers it; the selected view when left out.' },
        field: { ...CATEGORY_FIELD, description: 'A categorical field whose categories to frame, each on its own.' },
        categories: { type: 'array', items: CATEGORY_LABEL, minItems: 1, uniqueItems: true, description: 'Only these categories of the field; they are also framed together. Omitted, every category the view shows.' },
        azimuth: { type: 'number', description: 'Degrees around the vertical axis the camera looks from (3D views); omitted, the view\'s own. 90 apart is a quarter turn.' },
        elevation: { type: 'number', minimum: -85, maximum: 85, description: 'Degrees above (positive) or below the subject the camera looks from (3D views); omitted, the view\'s own.' },
        fill: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.8, description: 'How much of the frame the cells fill across or up: 0.8 a close shot with a margin, 0.4 the subject with its surroundings.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['view', 'embedding', 'navigation', 'direction', 'frame', 'whole'],
      properties: {
        view: { type: 'string' },
        embedding: { oneOf: [{ type: 'object', additionalProperties: false, required: ['name', 'dimension'], properties: { name: { type: 'string' }, dimension: { type: 'integer' } } }, { type: 'null' }] },
        navigation: { enum: ['orbit', 'planar'], description: 'The mode of the cameras: orbit for 3D, planar (facing the x–y plane) for 1D and 2D.' },
        direction: { oneOf: [{ type: 'object', additionalProperties: false, required: ['azimuth', 'elevation'], properties: { azimuth: { type: 'number' }, elevation: { type: 'number' } } }, { type: 'null' }] },
        frame: {
          type: 'object', additionalProperties: false, required: ['aspect', 'vertical_view_degrees', 'fill'],
          properties: { aspect: { type: 'number', description: 'Width over height of the view.' }, vertical_view_degrees: { type: 'number' }, fill: { type: 'number' } },
        },
        whole: FRAMED,
        together: { ...FRAMED, description: 'The categories named, in one shot.' },
        field: { type: 'string' },
        groups: { type: 'array', items: { ...FRAMED, required: ['label', ...FRAMED.required], properties: { label: { type: 'string' }, ...FRAMED.properties } } },
        not_shown: { type: 'array', items: { type: 'string' }, description: 'Categories with no cell the view shows (filtered or hidden).' },
      },
    },
    describe: () => 'Read where cells sit and cameras that frame them',
    code: params => `camera_framing(${params.field === undefined ? '' : JSON.stringify(params.field.key)})`,
  }),
]);
