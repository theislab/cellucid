/**
 * A generated fixture the page reads over real HTTP: its files are written
 * where the browser-test server (`scripts/serve-browser-tests.mjs`) serves
 * them, under the git-ignored `test-results/`, keyed by port so concurrent
 * runs never share one.
 *
 * A spec that measures how long the page's main thread is held serves its
 * dataset this way, never through `page.route`. WebKit's Playwright delivers
 * a fulfilled body through the page's own process, on its main thread: a
 * worker's fetch of a routed 16 MiB body holds the page for about 250 ms,
 * with no application code involved, while the same file served over HTTP
 * holds it for none. A routed dataset makes the harness, not the
 * application, the long task such a spec reports.
 */
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrowserTestPorts } from '../../../scripts/browser-test-ports.mjs';
import { appUrl } from './origins.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Write `files` (`{relativePath: bytes or text}`) as the served fixture
 * `name`, replacing what a previous run left there.
 *
 * @param {string} name
 * @param {Record<string, Uint8Array|string>} files
 * @returns {{root: string, remove: () => void}} `root`: the fixture's URL,
 *   ending in `/`; `remove` deletes its files
 */
export function writeServedFixture(name, files) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new TypeError(`A served fixture name is lowercase letters, digits and dashes: ${name}`);
  }
  const { port } = resolveBrowserTestPorts();
  const relative = `test-results/served-fixtures-${port}/${name}`;
  const directory = path.join(REPOSITORY_ROOT, relative);
  const remove = () => {
    rmSync(directory, { recursive: true, force: true });
    // The port's folder goes with its last fixture.
    try {
      rmdirSync(path.dirname(directory));
    } catch {
      // Another fixture of this run is still there.
    }
  };
  rmSync(directory, { recursive: true, force: true });
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root: appUrl(`/${relative}/`), remove };
}
