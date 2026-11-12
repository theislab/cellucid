/**
 * The community annotation Worker (contract 3) and the repository behind it,
 * for browser specs: the Worker's own routes (its root document, sign-in
 * routes) answered here, and every GitHub-relayed route (the GraphQL
 * snapshot and blob batches, trees, blobs, the Contents API, refs, forks,
 * pull requests) answered by the one in-memory GitHub the sync tests use
 * (`tests/helpers/community-annotation-worker.mjs` `MockAnnotationGitHub`),
 * so the node tests and the browser specs cannot speak two protocols. No
 * request leaves for GitHub.
 *
 * What a spec reads: `files` (path → {text, sha}: the branch as GitHub holds
 * it now), `mutations` (every write, with its decoded content), `requests`,
 * and `github` (the in-memory GitHub itself: commits, forks, pull requests).
 *
 * Hooks a spec sets: `onMutation(record)` and `onGet(pathname)` return
 * `'abort'` (the connection drops), `{status, body}` (GitHub's answer, the
 * operation id still echoed), or undefined (served as the repository
 * would); `hold()` keeps every next write waiting until the promise it
 * returns is resolved by the spec (`release`), so a spec acts while a write
 * is under way without waiting a set time.
 */
import {
  MockAnnotationGitHub,
  gitBlobSha,
  publishedJson,
} from '../../helpers/community-annotation-worker.mjs';
import {
  ANNOTATION_MERGES_FILE_VERSION,
  ANNOTATION_USER_FILE_VERSION,
} from '../../../assets/js/app/community-annotations/wire-contract.js';
import {
  OPERATION_ID_HEADER,
  OPERATION_OUTCOME_HEADER,
  WORKER_CONTRACT_VERSION,
  WORKER_ENDPOINTS,
  WORKER_EXPOSED_RESPONSE_HEADERS,
  WORKER_SERVICE,
} from '../../../assets/js/app/community-annotations/worker-contract.js';

export const WORKER_ORIGIN = 'https://worker.example';
export const AUTH_USER = Object.freeze({ id: 4242, login: 'tester' });
export const AUTH_USER_KEY = `ghid_${AUTH_USER.id}`;
export const REPO = 'team/labels';
export const AT = '2026-07-29T00:00:00.000Z';
const BRANCH = 'main';
const EXPOSE = WORKER_EXPOSED_RESPONSE_HEADERS.join(', ');

/** The Worker's root document: its identity, contract version and routes. */
export function capability() {
  return {
    status: 'ok',
    service: WORKER_SERVICE,
    contractVersion: WORKER_CONTRACT_VERSION,
    endpoints: [...WORKER_ENDPOINTS],
  };
}

/**
 * Answer a Worker request with JSON as the Worker does: the headers a page
 * may read exposed (`Access-Control-Expose-Headers`), plus `headers`.
 */
export function fulfillWorkerJson(route, document, status = 200, headers = {}) {
  return route.fulfill({
    status, contentType: 'application/json',
    headers: { 'access-control-expose-headers': EXPOSE, ...headers }, body: JSON.stringify(document),
  });
}

/** `annotations/config.json` listing each dataset with one annotated field. */
export function configDocument(datasets) {
  return {
    version: 1,
    supportedDatasets: datasets.map(({ id, name, field, minAnnotators = 1, threshold = 0.5 }) => ({
      datasetId: id, name, fieldsToAnnotate: [field],
      annotatableSettings: { [field]: { minAnnotators, threshold } }, closedFields: [],
    })),
  };
}

/** A user file (version 3) with suggestions keyed `<field>:<category>` and votes id → up|down. */
export function userDocument(id, login, datasetId, suggestions = {}, votes = {}) {
  return {
    version: ANNOTATION_USER_FILE_VERSION, username: `ghid_${id}`, githubUserId: id, login, displayName: login,
    updatedAt: AT,
    datasets: { [datasetId]: { fieldsToAnnotate: [], lastAccessedAt: AT, suggestions, votes } },
  };
}

/** A suggestion of `ghid_<by>`; its id names its proposer (`ghid_<by>_<rest>`, as the contract requires). */
export function suggestion(id, label, by, extra = {}) {
  if (!id.startsWith(`ghid_${by}_`)) throw new Error(`suggestion id ${id} must start with ghid_${by}_`);
  return { id, label, proposedBy: `ghid_${by}`, proposedAt: AT, ...extra };
}

/** The decoded user file of `ghid_<id>` as the repository holds it now, or null. */
export function remoteUserFile(state, id = AUTH_USER.id) {
  const file = state.files.get(`annotations/users/ghid_${id}.json`);
  return file === undefined ? null : JSON.parse(file.text);
}

/**
 * Serve the Worker and the repository to `target` (a page or a context).
 * @param {import('@playwright/test').Page|import('@playwright/test').BrowserContext} target
 */
export async function installAnnotationRepository(target, {
  author = true, push = true, allowForking = true, config, users = {}, mergesDoc = null,
} = {}) {
  const files = {
    // The template's users folder (a folder exists in Git only with a file in it).
    'annotations/users/.gitkeep': '\n',
    'annotations/config.json': publishedJson(config),
    'annotations/moderation/merges.json': publishedJson(
      mergesDoc ?? { version: ANNOTATION_MERGES_FILE_VERSION, updatedAt: AT, merges: [] },
    ),
  };
  for (const [key, doc] of Object.entries(users)) files[`annotations/users/${key}.json`] = publishedJson(doc);
  const [owner, repo] = REPO.split('/');
  const github = new MockAnnotationGitHub({
    owner, repo, branch: BRANCH, files, allowForking, user: { ...AUTH_USER },
    permissions: { pull: true, triage: false, push, maintain: author, admin: author },
  });

  const state = {
    github,
    mutations: [], requests: [],
    onMutation: null, onGet: null,
    held: null,
    /** The branch as GitHub holds it now: path → {text, sha}. */
    get files() {
      const out = new Map();
      for (const [path, value] of github.filesAt()) {
        if (typeof value === 'string') out.set(path, { text: value, sha: gitBlobSha(value) });
      }
      return out;
    },
    /** Write one file on the branch as another contributor would. */
    put(path, document) {
      github.commitFiles({ [path]: publishedJson(document) });
    },
    /** Every next write waits until `release()`; resolves once one waits. */
    hold() {
      let release;
      let arrived;
      const waiting = new Promise(resolve => { arrived = resolve; });
      state.held = { gate: new Promise(resolve => { release = resolve; }), arrived };
      return { waiting, release: () => { state.held = null; release(); } };
    },
  };

  await target.route(`${WORKER_ORIGIN}/**`, async route => {
    try {
      await answer(route);
    } catch (error) {
      // The page gave the request up (a Stop, a closed tab) while it waited.
      if (!/already handled|closed|Request context disposed/i.test(String(error?.message))) throw error;
    }
  });

  async function answer(route) {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    state.requests.push(`${method} ${url.pathname}`);
    const json = (body, status = 200, headers = {}) => fulfillWorkerJson(route, body, status, headers);
    if (method === 'GET' && url.pathname === '/') return json(capability());
    if (method === 'POST' && url.pathname === '/auth/revoke') return route.fulfill({ status: 204 });
    // One page each, as the Worker answers a collection.
    if (method === 'GET' && url.pathname === '/auth/installations') {
      return json({ items: [{ id: 71, account: { login: owner } }], nextPage: null });
    }
    if (method === 'POST' && url.pathname === '/auth/installation-repos') {
      return json({ items: [{ id: 1, full_name: REPO, private: false }], nextPage: null });
    }
    const headers = await request.allHeaders();
    const postData = request.postData();
    // The GraphQL routes are POSTs that only read.
    const write = method !== 'GET' && !url.pathname.startsWith('/graphql/');
    if (write) {
      const operation = { [OPERATION_ID_HEADER]: headers[OPERATION_ID_HEADER.toLowerCase()] ?? '' };
      let body = null;
      try { body = JSON.parse(postData ?? 'null'); } catch { body = postData; }
      const contentPath = decodeURIComponent(url.pathname.replace(/^\/api\/repos\/[^/]+\/[^/]+\/contents\//, ''));
      const decoded = typeof body?.content === 'string' ? Buffer.from(body.content, 'base64').toString('utf8') : null;
      const record = { method, path: url.pathname, contentPath, message: body?.message ?? null, sha: body?.sha ?? null, decoded };
      state.mutations.push(record);
      if (state.held !== null) {
        const { gate, arrived } = state.held;
        arrived(record);
        await gate;
      }
      const hook = state.onMutation?.(record);
      if (hook === 'abort') return route.abort('internetdisconnected');
      // GitHub's refusal, with the operation id echoed as the Worker does (not applied).
      if (hook && typeof hook === 'object') {
        return json(hook.body ?? { error: 'error' }, hook.status, { ...operation, [OPERATION_OUTCOME_HEADER]: 'not-applied' });
      }
    } else {
      const hook = state.onGet?.(url.pathname);
      if (hook === 'abort') return route.abort('internetdisconnected');
      if (hook && typeof hook === 'object') return json(hook.body ?? { error: 'error' }, hook.status);
    }
    // Asked without its condition: Playwright cannot fulfill a 304 on WebKit
    // ("Cannot fulfill with redirect status"), so the repository is always
    // answered in full here; the sync tests cover the 304 path.
    const { 'if-none-match': _condition, ...unconditional } = headers;
    const response = await github.fetch(request.url(), {
      method,
      headers: unconditional,
      ...(postData === null ? {} : { body: postData }),
    });
    return route.fulfill({
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), 'access-control-expose-headers': EXPOSE },
      body: await response.text(),
    });
  }
  return state;
}

/** Sign in as `AUTH_USER` before the page's modules run (the session a GitHub sign-in leaves). */
export async function signedIn(target) {
  await target.addInitScript(({ origin, user }) => {
    window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = origin;
    sessionStorage.setItem('cellucid:github-app-auth:session', JSON.stringify({ expiresAt: 4102444800000, token: 'synthetic-token', user }));
  }, { origin: WORKER_ORIGIN, user: AUTH_USER });
}
