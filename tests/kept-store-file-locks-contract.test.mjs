/**
 * A kept directory's files are read and removed under one lock
 * (`data/anndata/transcode/space.js`, `readingFiles`, `removingFiles`): the
 * Stored listing of a page reads every directory's manifest without holding
 * the directory, and a reader's opening forgets or removes directories
 * meanwhile. WebKit logs a read of a file removed after the read began as a
 * failed load ("WebKitBlobResource error 1"), whatever the caller does with
 * the error: Web contracts runs 41213981681 and 41255961977, macOS WebKit,
 * `kept-parts.spec.mjs`. Here a listing is held inside its read of a
 * manifest while another context forgets that file's kept copies: nothing
 * is removed until the read is done, and then the directory goes.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  TRANSCODED_DIRECTORY,
  forgetKeptFile,
  listKeptStores,
  openKeptJournal,
} from '../assets/js/data/anndata/transcode/space.js';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';

const IDENTITY = Object.freeze({ kind: 'remote', key: 'url:lung', version: 'census:1' });

/** `environment`'s storage, whose manifest reads wait for `held()` first. */
function heldManifests(environment, held) {
  const folder = handle => ({
    ...handle,
    async getFileHandle(name, options) {
      const file = await handle.getFileHandle(name, options);
      if (name !== 'manifest.json') return file;
      return { ...file, getFile: async () => { await held(); return file.getFile(); } };
    },
  });
  const parent = handle => ({
    ...handle,
    getDirectoryHandle: async (name, options) => folder(await handle.getDirectoryHandle(name, options)),
    async *entries() {
      for await (const [name, child] of handle.entries()) yield [name, child.kind === 'directory' ? folder(child) : child];
    },
  });
  const root = handle => ({
    ...handle,
    getDirectoryHandle: async (name, options) => (name === TRANSCODED_DIRECTORY ? parent : folder)(await handle.getDirectoryHandle(name, options)),
  });
  return {
    navigator: {
      storage: { ...environment.navigator.storage, getDirectory: async () => root(await environment.navigator.storage.getDirectory()) },
      get locks() {
        return environment.navigator.locks;
      },
    },
  };
}

test('a kept directory is removed only once the listing has read its files', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const journal = await openKeptJournal(IDENTITY, { environment: disk.environment, manifest: { kind: 'parts', size: 64 } });
  assert.notEqual(journal, null);
  await journal.appendRange('', 0, new Uint8Array(16).fill(7));
  journal.close();
  journal.release();
  const kept = path.join(disk.root, TRANSCODED_DIRECTORY);
  const [directory] = readdirSync(kept);
  const manifest = path.join(kept, directory, 'manifest.json');

  // The page lists what is kept, and is held inside its read of the manifest.
  let reached;
  const reading = new Promise(resolve => { reached = resolve; });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let first = true;
  const listing = listKeptStores(heldManifests(disk.as('page'), async () => {
    if (!first) return;
    first = false;
    reached();
    await released;
  }));
  await reading;

  // A reader's opening forgets the file meanwhile: its manifest and its
  // directory wait for the read. Checked once it asks to remove them (an
  // exclusive lock on the files, `space.js` `removingFiles`), or once it
  // ends, had it removed them without asking.
  let askedToRemove;
  const removing = new Promise(resolve => { askedToRemove = resolve; });
  const locks = disk.environment.navigator.locks;
  const forgetter = {
    navigator: {
      storage: disk.environment.navigator.storage,
      locks: {
        request(name, options, callback) {
          if (options?.mode === 'exclusive') askedToRemove();
          return locks.request(name, options, callback);
        },
      },
    },
  };
  const forgetting = forgetKeptFile(IDENTITY, forgetter);
  await Promise.race([removing, forgetting]);
  // A removal granted at once would have run by the next task.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(existsSync(manifest), true, 'the manifest is not removed while it is read');

  release();
  const items = await listing;
  assert.equal(await forgetting, 1);
  assert.equal(items.filter(item => item.kind === 'parts').length, 1, 'the listing read it whole');
  assert.equal(existsSync(path.join(kept, directory)), false, 'removed once read');
});
