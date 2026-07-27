import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('README stays concise, marketing-focused, and delegates guidance to the docs', () => {
  const headings = readme.match(/^#{1,6} .+$/gm) ?? [];
  assert.deepEqual(headings, ['# Cellucid', '## Features']);
  assert.ok(
    Buffer.byteLength(readme, 'utf8') <= 3_500,
    'README implementation guidance belongs in the central documentation'
  );
  assert.doesNotMatch(readme, /```/);
  assert.doesNotMatch(
    readme,
    /^## (?:Quick Start|Loading|Development|Repository Structure|License|Community)/m
  );

  const featuresStart = readme.indexOf('## Features');
  const documentationLink =
    'https://cellucid.readthedocs.io/en/latest/';
  const documentationStart = readme.lastIndexOf(documentationLink);
  assert.ok(featuresStart >= 0);
  assert.ok(
    documentationStart > featuresStart,
    'README must finish its feature story with the complete documentation link'
  );
  assert.match(
    readme,
    /\]\(https:\/\/cellucid\.readthedocs\.io\/en\/latest\/\)\.\s*$/
  );
});

test('README presents the current product surface without implementation detail', () => {
  const features = readme
    .slice(readme.indexOf('## Features'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '));
  assert.ok(features.length >= 7 && features.length <= 12);

  for (const required of [
    'WebGL',
    'multiview',
    'RNA-velocity',
    'volumetric smoke',
    'Camera Path',
    'Community annotation',
    'session state',
    'H5AD',
    'Zarr',
    'Jupyter',
    'Python',
    'R',
  ]) {
    assert.ok(readme.includes(required), `README must present ${required}`);
  }
});
