/**
 * Every vertex shader pins its attributes, one of them to location 0.
 *
 * A draw whose vertex attribute 0 is not an enabled array is legal WebGL, but
 * Firefox on desktop OpenGL then emulates that attribute for every vertex and
 * warns "Drawing without vertex attrib 0 array enabled forces the browser to
 * do expensive emulation work". With the locations left to the linker,
 * attribute 0 was whichever input it chose, and a program drew without it
 * whenever no earlier pass had happened to leave location 0 enabled: the
 * instanced connectivity edges did exactly that once the default background
 * stopped drawing the grid first.
 *
 * So every vertex shader in the tree names a location for every input, one of
 * them is 0, and no two share one. The program's draw path enables every input
 * it declares, so pinning one of them to 0 is what guarantees the draw runs
 * with attribute 0 enabled. Shaders are discovered from the source tree, not
 * listed, so a new one is held to the same rule.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const JS_ROOT = path.join(REPOSITORY_ROOT, 'assets', 'js');

async function glslModules(directory) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...await glslModules(entryPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const source = await readFile(entryPath, 'utf8');
    if (!source.includes('#version 300 es')) continue;
    modules.push({ relativePath: path.relative(REPOSITORY_ROOT, entryPath), source });
  }
  return modules;
}

/** Every shader source in a module: a template literal opening with `#version`. */
function shaderSources(source) {
  const shaders = [];
  let index = source.indexOf('`#version 300 es');
  while (index !== -1) {
    const end = source.indexOf('`', index + 1);
    assert.notEqual(end, -1, 'an unterminated shader template');
    const before = source.slice(Math.max(0, index - 200), index);
    const name = before.match(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*$/)?.[1]
      ?? before.match(/([A-Za-z0-9_$]+)\s*[:=]\s*$/)?.[1]
      ?? `<shader at ${index}>`;
    shaders.push({ name, text: source.slice(index + 1, end) });
    index = source.indexOf('`#version 300 es', end + 1);
  }
  return shaders;
}

const ATTRIBUTE = /^[ \t]*(?:layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*)?in\s+(?:(?:highp|mediump|lowp)\s+)?[A-Za-z0-9_]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;

function attributesOf(vertexSource) {
  return [...vertexSource.matchAll(ATTRIBUTE)].map(match => ({
    name: match[2],
    location: match[1] === undefined ? null : Number(match[1]),
  }));
}

test('the sweep finds the vertex shaders it is meant to check', async () => {
  const modules = await glslModules(JS_ROOT);
  const vertexShaders = modules.flatMap(module => shaderSources(module.source))
    .filter(shader => /\bgl_Position\b/.test(shader.text));
  // Points, highlight, centroids, edges, grid, orbit anchor, smoke, smoke
  // composite, density splats, normalize, noise, velocity overlay.
  assert.ok(
    vertexShaders.length >= 15,
    `found ${vertexShaders.length} vertex shaders; the sweep would otherwise assert nothing`
  );
  assert.ok(
    vertexShaders.every(shader => attributesOf(shader.text).length > 0),
    'every vertex shader in the tree reads at least one attribute'
  );
});

test('every vertex shader pins each input, one of them to location 0', async () => {
  const offenders = [];
  for (const module of await glslModules(JS_ROOT)) {
    for (const shader of shaderSources(module.source)) {
      if (!/\bgl_Position\b/.test(shader.text)) continue;
      const attributes = attributesOf(shader.text);
      if (attributes.length === 0) continue;
      const label = `${module.relativePath} ${shader.name}`;
      const unpinned = attributes.filter(attribute => attribute.location === null);
      if (unpinned.length > 0) {
        offenders.push(`${label}: ${unpinned.map(a => a.name).join(', ')} without a location`);
      }
      const locations = attributes
        .map(attribute => attribute.location)
        .filter(location => location !== null);
      if (!locations.includes(0)) {
        offenders.push(`${label}: no attribute at location 0`);
      }
      if (new Set(locations).size !== locations.length) {
        offenders.push(`${label}: two attributes share a location`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the sweep catches an unpinned input', () => {
  const unpinned = `#version 300 es
in vec2 a_quadPos;
void main() { gl_Position = vec4(a_quadPos, 0.0, 1.0); }`;
  assert.deepEqual(attributesOf(unpinned), [{ name: 'a_quadPos', location: null }]);
  const pinned = unpinned.replace('in vec2', 'layout(location = 0) in vec2');
  assert.deepEqual(attributesOf(pinned), [{ name: 'a_quadPos', location: 0 }]);
});
