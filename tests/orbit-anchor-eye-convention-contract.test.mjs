/**
 * The orbit anchor shades its compass for the pane's camera: `u_cameraPos`
 * is the eye the viewer orbits with (`viewer.js` `updateCamera`: phi the
 * polar angle from +Y, theta from +X towards +Z). It used a latitude
 * convention instead, which at the horizon (phi = pi/2) put the eye straight
 * overhead, so specular highlights and rim light faced a camera that was not
 * there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');


test('the anchor eye follows the viewer orbit convention', () => {
  const viewer = read('../assets/js/rendering/viewer.js');
  const anchor = read('../assets/js/rendering/orbit-anchor.js');
  assert.match(viewer, /eye\[0\] = target\[0\] \+ radius \* Math\.sin\(phi\) \* Math\.cos\(theta\);/);
  assert.match(viewer, /eye\[1\] = target\[1\] \+ radius \* Math\.cos\(phi\);/);
  assert.match(viewer, /eye\[2\] = target\[2\] \+ radius \* Math\.sin\(phi\) \* Math\.sin\(theta\);/);
  assert.match(anchor, /const camX = cx \+ viewRadius \* Math\.sin\(viewPhi\) \* Math\.cos\(viewTheta\);/);
  assert.match(anchor, /const camY = cy \+ viewRadius \* Math\.cos\(viewPhi\);/);
  assert.match(anchor, /const camZ = cz \+ viewRadius \* Math\.sin\(viewPhi\) \* Math\.sin\(viewTheta\);/);
});
