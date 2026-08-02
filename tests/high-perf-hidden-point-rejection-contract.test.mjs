import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  HP_FS_FULL,
  HP_FS_HIGHLIGHT,
  HP_FS_LIGHT,
  HP_FS_ULTRALIGHT,
  HP_VS_FULL,
  HP_VS_HIGHLIGHT,
  HP_VS_LIGHT,
} from '../assets/js/rendering/shaders/high-perf-shaders.js';
import {
  CENTROID_FS,
  CENTROID_VS,
} from '../assets/js/rendering/shaders/centroid-shaders.js';

/**
 * Hidden points must be rejected before rasterisation.
 *
 * `gl_PointSize = 0.0` does not do that. `ALIASED_POINT_SIZE_RANGE` starts at
 * 1.0 on the ANGLE/Metal driver this ships against, so a zero-size point is
 * clamped up to one pixel, assembled, rasterised, and only then thrown away —
 * measured directly: a shipped-shader point with alpha 0 lit 1 pixel with MSAA
 * off and 4 with MSAA on, while the same point moved outside the clip volume
 * lit none.
 *
 * Two consequences, both observed at ten million points:
 *
 *  - Cost. With everything hidden the GPU frame was 12x more expensive than it
 *    needed to be, and hiding 90 % of the dataset made rendering *no faster*
 *    than showing all of it.
 *  - Correctness. `HP_FS_ULTRALIGHT` has no `discard`, so in that quality a
 *    hidden point still writes depth and occludes visible points behind it —
 *    filtered-out cells silently delete cells the user asked to see.
 *
 * So the rejection belongs in the vertex shader, on `gl_Position`, for every
 * vertex shader a live program uses.
 *
 * CEL-0225 — why this file stopped grepping for one string.
 *
 * The sweep used to be `/if \(alpha < 0\.01\)/` over one module. That is a
 * spelling, not the rule. A texture-fetch shader in the same file hid points
 * with `if (col.a < 0.01) gl_PointSize = 0.0;` — same defect, different
 * variable, single-statement branch — and was invisible to the sweep for its
 * whole life; it was deleted in `255791eb7` for being unreachable, not for
 * being wrong. The rule is about the *assignment*, so the sweep now starts from
 * every `gl_PointSize = 0.0` in every module in the tree that carries GLSL,
 * finds the branch that guards it whatever the condition says, and requires
 * that branch to also put `gl_Position` outside the clip volume — checked
 * numerically against `-w <= c <= w` rather than against a particular constant,
 * because the velocity overlay rejects with `vec4(0.0, 0.0, -2.0, 1.0)` and is
 * just as correct as the point shaders' `vec4(2.0, 2.0, 2.0, 1.0)`.
 *
 * CEL-0241 — the last two offenders, and why the rule now has no exceptions.
 *
 * Generalising the sweep found two live shaders it could never have seen:
 * `HP_VS_HIGHLIGHT` and `CENTROID_VS`. Both were recorded as exceptions on the
 * ground that their fragment shaders discard, so neither could write depth over
 * a visible point. That reasoning was sound, and it was still the wrong thing
 * to rest on — it explains why neither was an emergency, never why the
 * construct should stay:
 *
 *  - `CENTROID_VS`'s branch is **live**. `state/managers/field/summary.js` sets
 *    a centroid's alpha to 0 for every category with no visible cells, so an
 *    ordinary filter drives it, and the centroid pass draws on the renderer's
 *    `depthMask(true)` (`viewer.js`, `drawCentroids`). One `discard` in another
 *    file was the whole of the protection.
 *  - `HP_VS_HIGHLIGHT`'s branch is **dead**. `MIN_VISIBLE_ALPHA_BYTE` is 3, and
 *    3/255 = 0.01176 > 0.01, so no vertex either producer packs can satisfy
 *    `a_color.a < 0.01`. It read as a safety net while being unable to fire.
 *
 * Both now carry the rejection. It was measured before it was applied, on
 * ANGLE Metal / Apple M1 Pro, 1024x768 single-sample, 4096 visible points with
 * 4096 hidden points placed in front of them:
 *
 *  - The picture does not move. Framebuffer digest with the shipped fragment
 *    shaders is identical with and without the rejection, for both shaders,
 *    against a twin arm that re-measured the first one last.
 *  - Rasterised fragments, counted before any discard, fall by exactly 4096 —
 *    one per hidden vertex, which is `ALIASED_POINT_SIZE_RANGE[0] = 1.0`
 *    clamping the zero-size point back up to a pixel.
 *  - With the fragment discard removed — the state either shader reaches the
 *    day someone decides the discard is redundant — hidden points take 4096
 *    pixels away from visible ones without the rejection, and 0 with it.
 *
 * So the exception list is gone rather than empty: there is no shader in the
 * tree that hides a point by shrinking it, and this file no longer has a place
 * to record one.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const JS_ROOT = path.join(REPOSITORY_ROOT, 'assets', 'js');

// =============================================================================
// A shader-source reader that finds the branch, not a spelling of it
// =============================================================================

/** Every module in the tree that carries GLSL, discovered rather than listed. */
async function readGlslModules(directory) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...await readGlslModules(entryPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const source = await readFile(entryPath, 'utf8');
    if (!source.includes('#version 300 es')) continue;
    modules.push({
      relativePath: path.relative(REPOSITORY_ROOT, entryPath),
      source,
    });
  }
  return modules.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** The innermost `{` enclosing `index`, or -1 at top level. */
function enclosingOpenBrace(source, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const character = source[i];
    if (character === '}') depth++;
    else if (character === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The `}` closing the block that opens at `openIndex`. */
function closingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const character = source[i];
    if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `(` matching the `)` at `closeIndex`. */
function openingParen(source, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    const character = source[i];
    if (character === ')') depth++;
    else if (character === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * If the text ending at `endIndex` is an `if (…)` header, its start index.
 *
 * The condition is read as balanced parentheses rather than as text, so
 * `a < 0.01`, `col.a < 0.01`, `v_alpha < 0.01 || speed < 0.00001` and anything
 * else a future shader writes are all the same to this check.
 */
function ifHeaderStart(source, endIndex) {
  let i = endIndex - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0 || source[i] !== ')') return -1;
  const open = openingParen(source, i);
  if (open < 0) return -1;
  let j = open - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 1 || source.slice(j - 1, j + 1) !== 'if') return -1;
  if (j - 2 >= 0 && /[A-Za-z0-9_]/.test(source[j - 2])) return -1;
  return j - 1;
}

/**
 * The branch guarding the statement at `index`, braced or single-statement.
 *
 * Returns `null` when the statement is not guarded at all, which is itself a
 * violation: an unconditional `gl_PointSize = 0.0` hides every point.
 */
function guardingBranch(source, index) {
  // Innermost guard first: a braceless `if (…) gl_PointSize = 0.0;` is a branch
  // of exactly one statement, and taking the enclosing block instead would let
  // an unrelated rejection elsewhere in that block excuse it.
  const inlineStart = ifHeaderStart(source, index);
  if (inlineStart >= 0) {
    const semicolon = source.indexOf(';', index);
    if (semicolon >= 0) return source.slice(inlineStart, semicolon + 1);
  }
  const open = enclosingOpenBrace(source, index);
  if (open >= 0) {
    const start = ifHeaderStart(source, open);
    if (start >= 0) {
      const close = closingBrace(source, open);
      if (close >= 0) return source.slice(start, close + 1);
    }
  }
  return null;
}

/** The shader constant a source offset belongs to. */
function owningExport(source, index) {
  const declarations = [
    ...source.slice(0, index).matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g),
  ];
  return declarations.length > 0
    ? declarations[declarations.length - 1][1]
    : null;
}

const LITERAL_CLIP_POSITION =
  /gl_Position\s*=\s*vec4\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/;

/**
 * Whether a branch moves the vertex outside the clip volume.
 *
 * The clip test is `-w <= c <= w` and a point sprite is clipped on its centre,
 * so one component failing it by any margin rejects the primitive. `w` must be
 * finite and positive: `w = 0` is a degenerate position, not a rejection.
 */
function clipRejection(branch) {
  const match = LITERAL_CLIP_POSITION.exec(branch);
  if (match === null) return null;
  const [x, y, z, w] = match.slice(1).map(Number);
  return {
    x,
    y,
    z,
    w,
    outside: Number.isFinite(w) && w > 0
      && [x, y, z].some(component => Math.abs(component) > w),
  };
}

const ZEROED_POINT_SIZE = /gl_PointSize\s*=\s*0(?:\.0*)?\s*;/g;

/** Every `gl_PointSize = 0.0` in a module, with the branch that guards it. */
function findZeroedPointSizes({ relativePath, source }) {
  const sites = [];
  for (const match of source.matchAll(ZEROED_POINT_SIZE)) {
    const branch = guardingBranch(source, match.index);
    sites.push({
      relativePath,
      shader: owningExport(source, match.index),
      line: source.slice(0, match.index).split('\n').length,
      branch,
      rejection: branch === null ? null : clipRejection(branch),
    });
  }
  return sites;
}

function isRejected(site) {
  return site.branch !== null
    && site.rejection !== null
    && site.rejection.outside;
}

function describe(site) {
  return `${site.relativePath}:${site.line} (${site.shader ?? 'no export'})`;
}

// =============================================================================
// Every point vertex shader that hides a point, with no exceptions
// =============================================================================

/**
 * The shaders a live point program can use, each of which hides a point.
 *
 * Every entry gets the same per-shader assertions. `SHADER_MODULES` below then
 * checks that this list is the whole of what the shaders directory contains, so
 * a new point shader cannot be covered only by the weaker tree-wide sweep.
 */
const LIVE_POINT_VERTEX_SHADERS = Object.freeze({
  HP_VS_FULL,
  HP_VS_LIGHT,
  HP_VS_HIGHLIGHT,
  CENTROID_VS,
});

/**
 * The fragment shader each hidden-point vertex shader is paired with.
 *
 * Their discards are no longer the only thing stopping a hidden point from
 * writing depth — the vertex rejection is — but they are still the second line
 * of defence, and `HP_FS_ULTRALIGHT`'s deliberate lack of one is what makes
 * `HP_VS_LIGHT`'s rejection a correctness fix rather than only a cost fix.
 */
const DISCARDING_FRAGMENT_SHADERS = Object.freeze({
  HP_FS_FULL,
  HP_FS_LIGHT,
  HP_FS_HIGHLIGHT,
  CENTROID_FS,
});

/** The modules that own a point program's vertex shader. */
const SHADER_MODULES = Object.freeze([
  'assets/js/rendering/shaders/high-perf-shaders.js',
  'assets/js/rendering/shaders/centroid-shaders.js',
]);

// =============================================================================
// Tests
// =============================================================================

test('every live point vertex shader rejects a hidden vertex from the clip volume', () => {
  for (const [name, source] of Object.entries(LIVE_POINT_VERTEX_SHADERS)) {
    const sites = findZeroedPointSizes({ relativePath: name, source });
    assert.equal(sites.length, 1, `${name} has no hidden-point branch at all`);
    const [site] = sites;
    assert.ok(
      site.branch !== null,
      `${name} zeroes gl_PointSize unconditionally`,
    );
    assert.ok(
      site.rejection !== null,
      `${name} must move a hidden vertex outside the clip volume, not only `
        + `shrink it; its branch is:\n${site.branch}`,
    );
    assert.ok(
      site.rejection.outside,
      `${name} rejects to (${site.rejection.x}, ${site.rejection.y}, `
        + `${site.rejection.z}, ${site.rejection.w}), which is inside the clip `
        + 'volume',
    );
  }
});

test('the rejected position is genuinely outside the clip volume for w = 1', () => {
  // Clip test is -w <= c <= w. Whatever constant the shaders use must fail it
  // by a wide margin, since a point sprite is clipped on its centre.
  for (const [name, source] of Object.entries(LIVE_POINT_VERTEX_SHADERS)) {
    const rejection = clipRejection(source);
    assert.ok(rejection, `${name} has no rejected position constant`);
    assert.equal(rejection.w, 1, `${name} must keep w finite and non-zero`);
    for (const component of ['x', 'y', 'z']) {
      assert.ok(
        Math.abs(rejection[component]) > rejection.w,
        `${name} ${component}=${rejection[component]} is inside the clip volume `
          + `for w=${rejection.w}`,
      );
    }
  }
});

test('the fragment shaders that discard still do, and the one that does not is named', () => {
  // The vertex-side rejection is a performance fix where the fragment shader
  // discards and a correctness fix where it does not. Both facts are load
  // bearing, so both are pinned.
  for (const [name, source] of Object.entries(DISCARDING_FRAGMENT_SHADERS)) {
    assert.match(
      source,
      /if \(v_alpha < 0\.01\) discard;/,
      `${name} is the second line of defence behind its vertex shader's `
        + 'rejection; losing it would put a hidden point one code change away '
        + 'from writing depth over a visible one again',
    );
  }
  assert.doesNotMatch(
    HP_FS_ULTRALIGHT,
    /discard/,
    'HP_FS_ULTRALIGHT discarding would change why the vertex rejection matters there',
  );
});

test('no shader in the tree hides a point by shrinking it alone', async () => {
  const modules = await readGlslModules(JS_ROOT);
  assert.ok(
    modules.length >= 8,
    `found ${modules.length} GLSL-bearing modules; the tree carries at least 8, `
      + 'so this sweep would otherwise assert nothing',
  );

  const offenders = [];
  let sitesSeen = 0;
  for (const module of modules) {
    for (const site of findZeroedPointSizes(module)) {
      sitesSeen++;
      if (isRejected(site)) continue;
      offenders.push(describe(site));
    }
  }

  assert.ok(
    sitesSeen >= 5,
    `found ${sitesSeen} hidden-point branches; the tree carries at least 5 `
      + '(four point shaders and the velocity overlay), so this sweep would '
      + 'otherwise assert nothing',
  );
  // No exception list. There was one, for HP_VS_HIGHLIGHT and CENTROID_VS; both
  // now reject, so the rule is unconditional and a new offender has nowhere to
  // be recorded as tolerable.
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')} hide a point by shrinking it, which the driver `
      + 'clamps back to one rasterised pixel. Reject the vertex from the clip '
      + 'volume in the same branch, as HP_VS_FULL does.',
  );
});

test('no point shader hides a point outside the per-shader contract above', async () => {
  // The tree sweep checks the rule; the per-shader tests check the margin, the
  // finite w, and that the branch exists at all. A new point shader that only
  // the sweep covers would be held to the weaker of the two, so the two sets
  // are pinned equal.
  const owners = new Set();
  for (const relativePath of SHADER_MODULES) {
    const source = await readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
    for (const site of findZeroedPointSizes({ relativePath, source })) {
      assert.notEqual(
        site.shader,
        null,
        `${describe(site)} hides a point outside any exported shader`,
      );
      owners.add(site.shader);
    }
  }
  assert.deepEqual(
    [...owners].sort(),
    Object.keys(LIVE_POINT_VERTEX_SHADERS).sort(),
    'every shader in the shaders directory that hides a point must be listed '
      + 'in LIVE_POINT_VERTEX_SHADERS, and every listed shader must still hide '
      + 'one',
  );
});

test('the sweep catches the construct the old one missed', () => {
  // The exact body of the texture-fetch shader deleted in 255791eb7, which hid
  // points with a different variable name in a single-statement branch and so
  // was invisible to a sweep that grepped for `if (alpha < 0.01)`.
  const reintroduced = `export const HP_VS_TEXTURE = \`#version 300 es
precision highp float;

uniform sampler2D u_positionTex;
uniform sampler2D u_colorTex;
uniform int u_texWidth;
uniform mat4 u_mvpMatrix;
uniform float u_pointSize;

out vec3 v_color;
out float v_alpha;

void main() {
  int idx = gl_VertexID;
  vec4 pos = texelFetch(u_positionTex, ivec2(idx, 0), 0);
  vec4 col = texelFetch(u_colorTex, ivec2(idx, 0), 0);

  gl_Position = u_mvpMatrix * vec4(pos.xyz, 1.0);
  gl_PointSize = u_pointSize;

  if (col.a < 0.01) gl_PointSize = 0.0;

  v_color = col.rgb;
  v_alpha = col.a;
}
\`;
`;

  const sites = findZeroedPointSizes({
    relativePath: 'scratch/reintroduced-offender.js',
    source: reintroduced,
  });

  assert.equal(sites.length, 1);
  assert.equal(sites[0].shader, 'HP_VS_TEXTURE');
  assert.equal(
    sites[0].branch,
    'if (col.a < 0.01) gl_PointSize = 0.0;',
    'the single-statement branch must be found without braces to delimit it',
  );
  assert.equal(
    sites[0].rejection,
    null,
    'a `gl_Position = u_mvpMatrix * …` earlier in main is not a rejection, and '
      + 'must not be mistaken for one',
  );
  assert.equal(
    isRejected(sites[0]),
    false,
    'so the sweep above would report it, with no exception list to land in',
  );
});

test('a rejection inside the clip volume is not accepted as one', () => {
  // The velocity overlay rejects with vec4(0.0, 0.0, -2.0, 1.0) and the point
  // shaders with vec4(2.0, 2.0, 2.0, 1.0). Both are correct, so the check is
  // numeric rather than textual — which means it also has to refuse the
  // constants that look like a rejection and are not.
  const branchFor = (position) => `if (alpha < 0.01) {
    gl_PointSize = 0.0;
    gl_Position = vec4(${position});
  }`;

  assert.equal(clipRejection(branchFor('2.0, 2.0, 2.0, 1.0')).outside, true);
  assert.equal(clipRejection(branchFor('0.0, 0.0, -2.0, 1.0')).outside, true);
  assert.equal(
    clipRejection(branchFor('0.0, 0.0, 1.0, 1.0')).outside,
    false,
    'z = w sits exactly on the far plane and is inside the clip volume',
  );
  assert.equal(
    clipRejection(branchFor('2.0, 2.0, 2.0, 4.0')).outside,
    false,
    'a large w brings the same components back inside',
  );
  assert.equal(
    clipRejection(branchFor('2.0, 2.0, 2.0, 0.0')).outside,
    false,
    'w = 0 is a degenerate position, not a rejection',
  );
});
