/**
 * Session format 4 (`assets/js/app/session/history-file.js`): a history in
 * one file, in the History v2 shape (`app/session/README.md`, "The file").
 *
 * - The golden history (every kind of record the model has) round-trips
 *   exactly through the writer and the reader, whole and in two stages.
 * - The active head's values are eager; every other value, the journal, the
 *   conversations and the arrays only steps' parameters name are lazy, and
 *   such a step's parameters come joined with the rest.
 * - JSON chunks are cut into bounded pieces; a chunk is gzip'd only where
 *   that pays; a sub-value values share is stored once (parts).
 * - Damaged, forged, bombed, truncated and foreign files are refused before
 *   anything is applied; a file of a newer Cellucid says so, naming what it
 *   does not know.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { goldenSession } from '../scripts/generate-history-golden.mjs';
import {
  CHUNK_TEXT_CHARS, assembleHistory, assertHistoryManifest, openHistoryFile, readHistoryFile, readHistoryFileManifest,
  writeHistoryFile,
} from '../assets/js/app/session/history-file.js';
import { foreignActions } from '../assets/js/app/session/app-stamp.js';
import { MAX_VALUE_TEXT, PART_MIN_CHARS, joinValue, partJoiner, splitValue } from '../assets/js/app/history/value-parts.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { readBundle } from '../assets/js/app/session/bundle/reader.js';
import { writeBundle } from '../assets/js/app/session/bundle/writer.js';
import {
  NOT_A_SESSION_FILE_MESSAGE, SESSION_BUNDLE_MAGIC_BYTES, SESSION_FORMAT_VERSION, otherSessionFormatMessage,
} from '../assets/js/app/session/bundle/format.js';
import { gzipCompress } from '../assets/js/app/session/codecs/gzip.js';

async function golden() {
  const session = await goldenSession();
  const write = (overrides = {}) => writeHistoryFile({
    header: session.header, app: session.app, actions: session.actions, scope: session.scope,
    history: { activeTracker: session.activeTracker, trackers: session.trackers }, valueOf: hash => session.values.get(hash),
    ...overrides,
  });
  return { ...session, write };
}

async function chunksOf(blob) {
  const { manifest, chunkStream } = await readBundle(blob, { signal: null, onProgress: null });
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk);
  return { manifest, chunks };
}

function reframe(manifest, chunks) {
  return writeBundle({ manifest, chunks: chunks.map(chunk => chunk.bytes ?? chunk) });
}

async function refusal(blob) {
  try {
    await readHistoryFile(blob);
  } catch (error) {
    return error;
  }
  throw new Error('A damaged session file was read.');
}

/** A chunk's payload, replaced (gzip'd, the manifest's sizes made to match). */
async function replaceChunk(manifest, chunks, id, payload) {
  const index = manifest.chunks.findIndex(chunk => chunk.id === id);
  const stored = await gzipCompress(payload, { signal: null });
  const changed = structuredClone(manifest);
  changed.chunks[index] = { ...changed.chunks[index], codec: 'gzip', storedBytes: stored.byteLength, uncompressedBytes: payload.byteLength };
  return reframe(changed, chunks.map((chunk, i) => (i === index ? stored : chunk.bytes)));
}

test('the golden history round-trips exactly: every tracker, step, journal entry, conversation and value', async () => {
  const session = await golden();
  const read = await readHistoryFile(await session.write());
  assert.deepEqual(read.history.trackers, session.trackers);
  assert.equal(read.history.activeTracker, session.activeTracker);
  for (const [hash, value] of read.values) {
    assert.equal(await hashValue(value), hash);
    assert.equal(await hashValue(session.values.get(hash)), hash);
  }
  const { app, actions, scope, createdAt } = read.manifest;
  assert.deepEqual({ app, actions, scope, createdAt }, { app: session.app, actions: session.actions, scope: session.scope, createdAt: session.header.createdAt });
});

test('the active head is eager; the rest, the journal and the conversations are lazy, in the order of their kinds', async () => {
  const session = await golden();
  const blob = await session.write();
  const { manifest } = await chunksOf(blob);
  const order = [...new Set(manifest.chunks.map(chunk => `${chunk.priority}:${chunk.kind}`))];
  assert.deepEqual(order, ['eager:steps', 'eager:parts', 'eager:array', 'eager:values', 'lazy:parts', 'lazy:array', 'lazy:values', 'lazy:journal', 'lazy:chat']);
  const file = await openHistoryFile(blob, { signal: null, onProgress: null });
  const eager = await file.readEager();
  assert.ok(eager.history.trackers.every(tracker => tracker.journal.length === 0 && tracker.chats.length === 0));
  const rest = await file.readRest();
  assert.deepEqual(rest.journals.map(entry => entry.tracker), session.trackers.filter(tracker => tracker.journal.length > 0).map(tracker => tracker.id));
  assert.deepEqual(assembleHistory(eager, rest).history.trackers, session.trackers);
});

test('a step whose parameters name an array only the lazy chunks hold comes joined with the rest', async () => {
  const session = await golden();
  // A brush whose cells no value shows at the head: its parameters' array is lazy.
  const tracker = structuredClone(session.trackers[0]);
  const cells = Uint32Array.from({ length: 5000 }, (_, i) => i * 3);
  const step = tracker.steps.find(candidate => candidate.kind === 'action' && candidate.id !== tracker.headId);
  step.params = { ...step.params, extra: cells };
  const trackers = [tracker, ...session.trackers.slice(1)];
  const blob = await session.write({ history: { activeTracker: session.activeTracker, trackers } });
  const file = await openHistoryFile(blob, { signal: null, onProgress: null });
  const eager = await file.readEager();
  const late = eager.history.trackers[0].steps.find(candidate => candidate.id === step.id);
  assert.ok(Object.hasOwn(late.params.extra, '$array'), 'still a skeleton before the rest is read');
  const rest = await file.readRest();
  const joined = rest.params.find(entry => entry.step === step.id);
  assert.deepEqual(joined.params.extra, cells);
  assert.deepEqual(assembleHistory(eager, rest).history.trackers[0], tracker);
});

test('JSON chunks are cut into bounded pieces and read back as one', async () => {
  const session = await golden();
  // Steps long enough to pass one piece: a tracker of many steps, each with a long label.
  const tracker = structuredClone(session.trackers[0]);
  const long = 'x'.repeat(4096);
  for (const step of tracker.steps) step.label = `${step.label} ${long}`;
  const pieces = Math.ceil((tracker.steps.length * long.length) / CHUNK_TEXT_CHARS);
  assert.ok(pieces >= 1);
  const blob = await session.write({ history: { activeTracker: session.activeTracker, trackers: [tracker, ...session.trackers.slice(1)] } });
  const read = await readHistoryFile(blob);
  assert.deepEqual(read.history.trackers[0], tracker);
  // The writer's cut, forced small: a steps list across chunks, as a reader must take it.
  const { manifest, chunks } = await chunksOf(blob);
  const id = manifest.trackers[0].steps[0];
  const index = manifest.chunks.findIndex(chunk => chunk.id === id);
  const all = JSON.parse(new TextDecoder().decode(await (await import('../assets/js/app/session/codecs/gzip.js')).gzipDecompress(chunks[index].bytes, { maxOutputBytes: manifest.chunks[index].uncompressedBytes, signal: null })));
  const halves = [all.slice(0, 5), all.slice(5)].map(list => new TextEncoder().encode(JSON.stringify(list)));
  const split = structuredClone(manifest);
  const metas = halves.map((payload, k) => ({ ...manifest.chunks[index], id: `${id}-${k}`, codec: 'none', storedBytes: payload.byteLength, uncompressedBytes: payload.byteLength }));
  split.chunks.splice(index, 1, ...metas);
  split.trackers[0].steps = metas.map(meta => meta.id);
  const list = chunks.map(chunk => chunk.bytes);
  list.splice(index, 1, ...halves);
  assert.deepEqual((await readHistoryFile(reframe(split, list))).history.trackers[0], tracker);
  // Named in another order than the file holds them: refused, never read as another list.
  const swapped = structuredClone(split);
  swapped.trackers[0].steps.reverse();
  assert.match((await refusal(reframe(swapped, list))).message, /names its steps chunks in another order than the file holds them/);
});

test('a chunk is gzip\'d only where that saves a sixteenth; stored as it is it reads the same', async () => {
  const session = await golden();
  const { manifest } = await chunksOf(await session.write());
  for (const chunk of manifest.chunks) {
    if (chunk.codec === 'none') assert.equal(chunk.storedBytes, chunk.uncompressedBytes);
    else assert.ok(chunk.storedBytes * 16 <= chunk.uncompressedBytes * 15, `${chunk.id} gzip'd for too little`);
  }
  assert.ok(manifest.chunks.some(chunk => chunk.codec === 'none'));
  assert.ok(manifest.chunks.some(chunk => chunk.codec === 'gzip'));
});

test('a sub-value values share is a part stored once; a part that names itself or expands past a page is refused', async () => {
  const genes = Array.from({ length: 300 }, (_, i) => `GENE${i}`);
  const arrays = new Map();
  const parts = new Map();
  const a = await splitValue({ result: { genes, run: 1 } }, arrays, parts);
  const b = await splitValue({ result: { genes, run: 2 } }, arrays, parts);
  assert.equal(parts.size, 1);
  assert.ok(JSON.stringify(parts.values().next().value).length >= PART_MIN_CHARS);
  const joiner = partJoiner({ skeletonOf: name => parts.get(name), arrayOf: digest => arrays.get(digest) });
  const joinedA = joiner.join(a);
  assert.equal(joinedA.result.genes, joiner.join(b).result.genes, 'one value joined once, shared');
  assert.equal(await hashValue(joinedA), await hashValue({ result: { genes, run: 1 } }));
  // A part naming itself through another.
  const p = 'a'.repeat(64);
  const q = 'b'.repeat(64);
  const cyclic = new Map([[p, [{ $part: q }]], [q, [{ $part: p }]]]);
  const loop = partJoiner({ skeletonOf: name => cyclic.get(name), arrayOf: () => null });
  assert.throws(() => loop.join({ $part: p }), /part inside itself/);
  // Parts that double each level: 2^40 copies of a short list, refused before anything is expanded.
  const bomb = new Map();
  const names = Array.from({ length: 41 }, (_, i) => i.toString(16).padStart(64, '0'));
  bomb.set(names[0], ['x'.repeat(100)]);
  for (let i = 1; i < names.length; i++) bomb.set(names[i], [{ $part: names[i - 1] }, { $part: names[i - 1] }]);
  const bombed = partJoiner({ skeletonOf: name => bomb.get(name), arrayOf: () => null });
  assert.throws(() => bombed.join({ $part: names[40] }), new RegExp(`more than a page can hold \\(${MAX_VALUE_TEXT}\\)`));
  await assert.rejects(splitValue({ $part: p }, new Map(), new Map()), /reserved key .*"\$part"/);
  // A malformed part is said as malformed, before anything is looked for.
  assert.throws(() => partJoiner({ skeletonOf: () => { throw new Error('looked for'); }, arrayOf: () => null }).join({ a: { $part: 'x' } }), /names a part wrongly/);
  assert.throws(() => joinValue({ $part: p }, () => null), /names a part where none may be/);
});

test('a part is named by the SHA-256 of its text with the names of the parts inside it; any own key round-trips', async () => {
  const { createHash } = await import('node:crypto');
  const inner = Array.from({ length: 200 }, (_, i) => `G${i}`);
  // A part inside a part, the same sub-value twice, an array, and keys a plain assignment would mishandle.
  const value = JSON.parse(`{"outer": ${JSON.stringify({ inner, again: inner, note: 'x'.repeat(600) })}, "__proto__": {"kept": true}, "constructor": 1}`);
  value.outer.cells = Uint32Array.of(1, 5, 9);
  const arrays = new Map();
  const parts = new Map();
  const skeleton = await splitValue(value, arrays, parts);
  assert.equal(parts.size, 2, 'the shared inner list once, and the outer object');
  const textOf = node => JSON.stringify(node);
  for (const [name, part] of parts) assert.equal(name, createHash('sha256').update(textOf(part)).digest('hex'));
  const joined = partJoiner({ skeletonOf: name => parts.get(name), arrayOf: digest => arrays.get(digest) }).join(skeleton);
  assert.equal(Object.getPrototypeOf(joined), Object.prototype);
  assert.ok(Object.hasOwn(joined, '__proto__') && Object.hasOwn(joined, 'constructor'));
  assert.equal(await hashValue(joined), await hashValue(value));
});

test('a part nothing refers to, a value no step refers to and a step whose value is missing are refused', async () => {
  const session = await golden();
  const { manifest, chunks } = await chunksOf(await session.write());
  const lazyParts = manifest.chunks.find(chunk => chunk.kind === 'parts' && chunk.priority === 'lazy');
  const index = manifest.chunks.indexOf(lazyParts);
  const { gzipDecompress } = await import('../assets/js/app/session/codecs/gzip.js');
  const payload = chunks[index].bytes;
  const text = new TextDecoder().decode(lazyParts.codec === 'gzip' ? await gzipDecompress(payload, { maxOutputBytes: lazyParts.uncompressedBytes, signal: null }) : payload);
  const record = JSON.parse(text);
  record['f'.repeat(64)] = ['an orphan'];
  const orphan = await replaceChunk(manifest, chunks, lazyParts.id, new TextEncoder().encode(JSON.stringify(record)));
  assert.match((await refusal(orphan)).message, /a part nothing refers to/);
  const lazyValues = manifest.chunks.findIndex(chunk => chunk.kind === 'values' && chunk.priority === 'lazy');
  const dropped = structuredClone(manifest);
  dropped.chunks.splice(lazyValues, 1);
  assert.match((await refusal(reframe(dropped, chunks.filter((_, i) => i !== lazyValues)))).message, /refers to a value the file does not hold/);
});

test('a forged value, a forged array and a chunk that inflates past its size are refused', async () => {
  const session = await golden();
  const { manifest, chunks } = await chunksOf(await session.write());
  const eagerValues = manifest.chunks.find(chunk => chunk.kind === 'values' && chunk.priority === 'eager');
  const read = await readHistoryFile(await session.write());
  const forged = {};
  const arrays = new Map();
  const parts = new Map();
  const file = await openHistoryFile(await session.write(), { signal: null, onProgress: null });
  const eager = await file.readEager();
  await file.cancel('read');
  for (const [hash, value] of eager.values) forged[hash] = await splitValue(value, arrays);
  const [first] = Object.keys(forged);
  forged[first] = { forged: true };
  assert.match((await refusal(await replaceChunk(manifest, chunks, eagerValues.id, new TextEncoder().encode(JSON.stringify(forged))))).message, /does not match its hash/);
  const raw = manifest.chunks.find(chunk => chunk.kind === 'array' && chunk.encoding === 'raw' && chunk.uncompressedBytes > 8);
  assert.match((await refusal(await replaceChunk(manifest, chunks, raw.id, new Uint8Array(raw.uncompressedBytes).fill(7)))).message, /does not match its digest/);
  const bomb = await gzipCompress(new Uint8Array(1 << 20), { signal: null });
  const bombed = structuredClone(manifest);
  const at = bombed.chunks.findIndex(chunk => chunk.id === eagerValues.id);
  bombed.chunks[at] = { ...bombed.chunks[at], codec: 'gzip', storedBytes: bomb.byteLength, uncompressedBytes: 64 };
  assert.ok(await refusal(reframe(bombed, chunks.map((chunk, i) => (i === at ? bomb : chunk.bytes)))));
  assert.equal(parts.size, 0);
  assert.ok(read.values.size > 0);
});

test('a manifest that is not exactly a history is refused before any chunk is read', async () => {
  const session = await golden();
  const { manifest, chunks } = await chunksOf(await session.write());
  const cases = [
    [m => { m.activeTracker = m.trackers[1].id.replace(/.$/, '0'); }, /active tracker is not one it holds/],
    [m => { m.trackers.push(structuredClone(m.trackers[0])); }, /holds the tracker .* twice/],
    [m => { m.trackers = []; }, /holds no tracker/],
    [m => { m.trackers[0].steps = m.trackers[1].steps; }, /names a steps chunk that is not its own/],
    [(m, list) => { m.chunks.reverse(); list.reverse(); }, /out of order/],
    [m => { m.chunks.find(c => c.kind === 'chat').priority = 'eager'; }, /out of order|is read last/],
    [m => { m.chunks.find(c => c.kind === 'values').kind = 'pictures'; }, /kind must be one of/],
    [m => { m.chunks.find(c => c.kind === 'array').encoding = 'zip'; }, /encoding must be raw/],
    [m => { m.trackers[0].extra = true; }, /must contain exactly/],
    [m => { m.extra = true; }, /must contain exactly/],
    [m => { m.chunks.find(c => c.kind === 'array').digest = 'Map:1:00'; }, /is not the digest of an array/],
    [m => { const chunk = m.chunks.find(c => c.codec === 'none'); chunk.uncompressedBytes += 1; }, /stored as it is, at another size/],
  ];
  for (const [mutate, pattern] of cases) {
    const changed = structuredClone(manifest);
    const list = [...chunks];
    mutate(changed, list);
    assert.match((await refusal(reframe(changed, list))).message, pattern, String(mutate));
  }
  assert.deepEqual(assertHistoryManifest(structuredClone(manifest)), manifest);
  assert.deepEqual(await readHistoryFileManifest(await session.write()), manifest);
});

test('the model\'s rules are the writer\'s and the reader\'s: a broken tree is refused, naming the rule', async () => {
  const session = await golden();
  const cases = [
    [t => { t[0].headId = 's999'; }, /head/],
    [t => { t[0].steps[1].parent = 's7'; }, /disagree|numbered before its parent/],
    [t => { t[0].branches[1].name = t[0].branches[0].name; }, /share the name/],
    [t => { t[0].nextStep = 2; }, /numbered past nextStep/],
  ];
  for (const [mutate, pattern] of cases) {
    const trackers = structuredClone(session.trackers);
    mutate(trackers);
    await assert.rejects(session.write({ history: { activeTracker: session.activeTracker, trackers } }), pattern);
  }
});

test('a file of a newer Cellucid names the part of the state this version lacks and the version that wrote it', async () => {
  const session = await golden();
  const { manifest, chunks } = await chunksOf(await session.write());
  const id = manifest.trackers[1].steps[0];
  const index = manifest.chunks.findIndex(chunk => chunk.id === id);
  const { gzipDecompress } = await import('../assets/js/app/session/codecs/gzip.js');
  const meta = manifest.chunks[index];
  const steps = JSON.parse(new TextDecoder().decode(meta.codec === 'gzip' ? await gzipDecompress(chunks[index].bytes, { maxOutputBytes: meta.uncompressedBytes, signal: null }) : chunks[index].bytes));
  steps[1].touches = [...steps[1].touches, 'holograms'];
  steps[1].before.holograms = 'a'.repeat(64);
  steps[1].after.holograms = 'b'.repeat(64);
  const newer = structuredClone(manifest);
  newer.app.version = '0.9.9';
  const blob = await replaceChunk(newer, chunks, id, new TextEncoder().encode(JSON.stringify(steps)));
  assert.match((await refusal(blob)).message, /written by Cellucid 0\.9\.9 .* \("holograms"\)\. Open it with that version or a newer one/);
});

test('steps of an action this catalogue lacks, or of parameters it cannot upgrade, are shown and not replayable', async () => {
  const session = await golden();
  const steps = session.trackers.flatMap(tracker => tracker.steps);
  assert.equal((await foreignActions({ app: session.app, actions: session.actions }, steps, session.catalog)).size, 0);
  const [stamp] = session.actions;
  const changed = { app: { ...session.app, version: '0.9.8' }, actions: [{ ...stamp, params: 'f'.repeat(64) }, ...session.actions.slice(1)] };
  const foreign = await foreignActions(changed, steps, session.catalog);
  assert.deepEqual([...foreign], [[stamp.type, 'Recorded with another version (0.9.8): shown, not replayable.']]);
  const unknown = await foreignActions(session, [{ type: 'hologram.show', v: 1 }], session.catalog);
  assert.deepEqual([...unknown.keys()], ['hologram.show']);
  const newer = await foreignActions(session, [{ type: stamp.type, v: 99 }], session.catalog);
  assert.match(newer.get(stamp.type), /newer Cellucid/);
});

test('other formats, other files, truncation, trailing bytes and cancellation', async () => {
  assert.equal(SESSION_FORMAT_VERSION, 4);
  for (const version of [1, 2, 3]) {
    const bytes = new TextEncoder().encode(`CELLUCID_SESSION/${version}\n${'{"chunks":[]}'.padEnd(40)}`);
    assert.equal((await refusal(new Blob([bytes]))).message, otherSessionFormatMessage(version));
  }
  for (const text of ['', 'PNG', 'CELLUCID_SESSION\n not a version, long enough']) {
    assert.equal((await refusal(new Blob([new TextEncoder().encode(text)]))).message, NOT_A_SESSION_FILE_MESSAGE);
  }
  const session = await golden();
  const blob = await session.write();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.match((await refusal(new Blob([bytes.subarray(0, bytes.byteLength - 7)]))).message, /truncated|Unexpected end/);
  assert.match((await refusal(new Blob([bytes, Uint8Array.of(0)]))).message, /trailing bytes/);
  const longManifest = new Uint8Array(bytes);
  new DataView(longManifest.buffer).setUint32(SESSION_BUNDLE_MAGIC_BYTES.byteLength, 0x7fff_ffff, true);
  assert.match((await refusal(new Blob([longManifest]))).message, /more than the session file holds/);
  const controller = new AbortController();
  const file = await openHistoryFile(blob, { signal: controller.signal, onProgress: null });
  controller.abort(new Error('stop'));
  await assert.rejects(file.readEager(), /stop/);
  const progress = [];
  const again = await openHistoryFile(blob, { signal: null, onProgress: loaded => progress.push(loaded) });
  await again.readEager();
  await again.readRest();
  assert.equal(progress.at(-1), blob.size);
});

test('the page chrome outside the history is checked: a map of pressed-button groups to their pressed button', async () => {
  const { assertPageChrome, NO_PAGE_CHROME } = await import('../assets/js/app/session/history-file.js');
  assert.deepEqual(assertPageChrome({ pressed: { 'highlight-mode': 'highlight-mode-lasso' } }), { pressed: { 'highlight-mode': 'highlight-mode-lasso' } });
  assert.deepEqual(NO_PAGE_CHROME, { pressed: {} });
  for (const bad of [null, [], { pressed: [] }, { pressed: {}, extra: 1 }, { pressed: { '': 'x' } }, { pressed: { g: '' } }, { pressed: { g: 3 } }, { pressed: { g: ' b' } }, { pressed: { ' g': 'b' } }]) {
    assert.throws(() => assertPageChrome(bad), /This session file is damaged: its page chrome/, JSON.stringify(bad));
  }
  const session = await golden();
  const blob = await session.write({ chrome: { pressed: { 'highlight-mode': 'highlight-mode-polygon' } } });
  assert.deepEqual((await readHistoryFileManifest(blob)).chrome, { pressed: { 'highlight-mode': 'highlight-mode-polygon' } });
});
