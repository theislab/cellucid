/**
 * The repository's files, for the contracts that read every module of a
 * folder: paths of this system to read, and names relative to a folder that
 * are '/'-separated on every system.
 *
 * A file URL's `pathname` is no path on Windows (`/D:/a/...`, which
 * `path.join()` and `path.resolve()` turn into `D:\D:\a\...`), and
 * `path.relative()` separates with `\` there, so a contract that compared a
 * module's name with `'app/...'` would fail on every Windows job.
 * `tests/windows-paths-contract.test.mjs` keeps the first out of every test.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository's root folder, as a path of this system. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A repository path ('/'-separated, from its root) as a path of this system. */
export function repositoryPath(relative) {
  return path.join(REPOSITORY_ROOT, ...relative.split('/'));
}

/** `file` relative to `folder`, '/'-separated on every system. */
export function relativePath(folder, file) {
  return path.relative(folder, file).split(path.sep).join('/');
}

/**
 * Every file under the repository folder `folder` whose name `keep` accepts,
 * in folders `enter` accepts: `{ path, relative }` sorted by `relative`, the
 * file's name from `folder`, '/'-separated.
 *
 * @param {string} folder - '/'-separated, from the repository's root.
 * @param {{ keep?: (name: string) => boolean, enter?: (name: string) => boolean }} [options]
 * @returns {{ path: string, relative: string }[]}
 */
export function sourceFiles(folder, { keep = name => name.endsWith('.js'), enter = () => true } = {}) {
  const root = repositoryPath(folder);
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (enter(entry.name)) walk(absolute);
      } else if (keep(entry.name)) {
        files.push({ path: absolute, relative: relativePath(root, absolute) });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}
