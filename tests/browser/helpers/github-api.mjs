/**
 * GitHub's API as the GitHub provider asks it when it opens a file
 * (`assets/js/data/sources/providers/github.js`, `lastCommitOf`): the commit
 * that last wrote the file on its ref, which the file is then read at
 * (`raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>`). A spec that
 * opens a GitHub link or catalog answers it here, so no request leaves for
 * the real api.github.com (which answers a test repository 404, logged as a
 * failed resource, and counts against its hourly budget for this network).
 */
import { jsonResponse } from './anndata-server.mjs';

/** A commit id as GitHub names one: 40 hexadecimal digits. */
export const TEST_COMMIT = '0123456789abcdef0123456789abcdef01234567';

/**
 * Answer "which commit last wrote <path>" for every path of one repository
 * with `commit`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{owner: string, repo: string, commit?: string}} repository
 */
export async function answerLastCommit(page, { owner, repo, commit = TEST_COMMIT }) {
  const prefix = `https://api.github.com/repos/${owner}/${repo}/commits?`;
  await page.route(url => url.href.startsWith(prefix), route => jsonResponse(route, [{ sha: commit }]));
}
