import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * A press held on the plot belongs to the viewer, never to text selection.
 *
 * iOS Safari starts a text selection on a long press wherever the element
 * under the finger is selectable; on the plot there is no text, so the
 * selection grew to the whole page. Safari honors only `-webkit-user-select`,
 * so an unprefixed `user-select: none` is ignored there: every declaration is
 * paired with its prefixed twin, and the plot's touch surfaces also refuse
 * the long-press callout menu.
 */

const ROOT = new URL('../', import.meta.url);

async function collectFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute, extension)));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(absolute);
  }
  return files.sort();
}

test('every user-select declaration carries the -webkit- twin Safari reads', async () => {
  const cssRoot = fileURLToPath(new URL('assets/css/', ROOT));
  const offenders = [];
  for (const file of await collectFiles(cssRoot, '.css')) {
    const source = await readFile(file, 'utf8');
    for (const [, body] of source.matchAll(/\{([^{}]*)\}/g)) {
      for (const [, value] of body.matchAll(/(?<![-\w])user-select:\s*([^;]+);/g)) {
        if (!body.includes(`-webkit-user-select: ${value};`)) {
          offenders.push(`${path.relative(cssRoot, file)}: user-select: ${value}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('inline user-select written from script sets the -webkit- twin too', async () => {
  const offenders = [];
  for (const file of await collectFiles(fileURLToPath(new URL('assets/js/', ROOT)), '.js')) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/style\.userSelect = ('[^']*')/g)) {
      if (!source.includes(`style.webkitUserSelect = ${match[1]}`)) {
        offenders.push(`${path.basename(file)}: userSelect = ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
