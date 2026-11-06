/**
 * An in-memory GitHub behind the community-annotation Worker (contract 3),
 * for the sync tests: repositories with commits and branches (a fork shares
 * its parent's objects), conditional repository metadata, the GraphQL
 * snapshot and blob routes, trees and blobs by id, the Contents API, refs
 * (created, read, force-moved), forks (made with `forkOnGitHub`, as the
 * contributor does on GitHub; listed), pull requests (squash-merged on
 * demand) and `/auth/user`. Every request is logged; `intercept(request)`
 * may answer one instead (a fault, a race).
 *
 * Also: a virtual clock with its timers, and a transport on it
 * (`worker-request.js`), so retries and stall timeouts run in virtual time.
 */

import { createHash } from 'node:crypto';
import { createHostBook } from '../../assets/js/formats/io/hosts.js';
import { ResponseClock } from '../../assets/js/formats/io/link.js';
import { ANNOTATION_SCHEMA_BLOB_OIDS } from '../../assets/js/app/community-annotations/wire-contract.js';

export const WORKER_ORIGIN = 'https://worker.example';
const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';

const blobShas = new Map();

/** Git's blob id of a text. */
export function gitBlobSha(text) {
  let sha = blobShas.get(text);
  if (sha === undefined) {
    const bytes = Buffer.from(text, 'utf8');
    sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blobShas.size > 200_000) blobShas.clear();
    blobShas.set(text, sha);
  }
  return sha;
}

function hashOf(text) {
  return createHash('sha1').update(text).digest('hex');
}

/** A blob whose content is never read (a schema): `{oid, byteSize}`. */
export function opaqueBlob(oid, byteSize = 100) {
  return Object.freeze({ oid, byteSize });
}

/** The template's schema files, by their canonical blob ids. */
export function schemaFiles() {
  return {
    'annotations/schema.json': opaqueBlob(ANNOTATION_SCHEMA_BLOB_OIDS.user),
    'annotations/config.schema.json': opaqueBlob(ANNOTATION_SCHEMA_BLOB_OIDS.config),
    'annotations/moderation/merges.schema.json': opaqueBlob(ANNOTATION_SCHEMA_BLOB_OIDS.merges),
  };
}

export function publishedJson(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ------------------------------------------------------------------------
// The wire shapes: every answer of the Worker's GitHub routes, built from a
// branch's files (`Map<path, value>`). A value is a text (its id is Git's
// blob id of it) or `{oid, byteSize?, text?}`: a blob under an id of the
// caller's choosing, read as `text` (absent: a blob nobody reads, such as a
// schema). `MockAnnotationGitHub` answers with these, and so does every
// browser stand-in, so no two mocks speak two protocols.
// ------------------------------------------------------------------------

const RATE_LIMIT = Object.freeze({ cost: 1, limit: 5000, resetAt: '2027-01-01T00:00:00Z' });

/** One file of a branch as a blob: `{oid, byteSize, text}` (`text` null: never read). */
export function blobOf(value) {
  if (typeof value === 'string') return { oid: gitBlobSha(value), byteSize: Buffer.byteLength(value), text: value };
  const text = typeof value?.text === 'string' ? value.text : null;
  return { oid: value.oid, byteSize: value.byteSize ?? (text === null ? 100 : Buffer.byteLength(text)), text };
}

/** The id of the tree at `prefix` (`'annotations/'`, …) of a branch's files. */
export function treeOidOf(files, prefix) {
  const listing = [...files].filter(([path]) => path.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, value]) => `${path}:${blobOf(value).oid}`).join('\n');
  return hashOf(`tree\n${prefix}\n${listing}`);
}

/**
 * The entries of the tree at `prefix`, by name: blobs with their id and size,
 * subtrees with their id (`onTree(oid, prefix)` is told of each subtree).
 */
export function treeEntriesOf(files, prefix, onTree = null) {
  const entries = new Map();
  for (const [path, value] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [name, ...deeper] = rest.split('/');
    if (deeper.length === 0) {
      const blob = blobOf(value);
      entries.set(name, { name, type: 'blob', oid: blob.oid, byteSize: blob.byteSize });
    } else if (!entries.has(name)) {
      entries.set(name, { name, type: 'tree', oid: null, prefix: `${prefix}${name}/` });
    }
  }
  for (const entry of entries.values()) {
    if (entry.type !== 'tree') continue;
    entry.oid = treeOidOf(files, entry.prefix);
    onTree?.(entry.oid, entry.prefix);
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * `POST /graphql/snapshot` for a branch: its tip commit and the
 * `annotations` and `annotations/moderation` trees with their entries.
 * `tipOid` defaults to an id derived from the `annotations` tree, so a
 * change under it is a new commit.
 */
export function snapshotDocument(files, { tipOid = null, onTree = null } = {}) {
  const treeAt = (prefix) => {
    if (![...files.keys()].some((path) => path.startsWith(prefix))) return null;
    const oid = treeOidOf(files, prefix);
    onTree?.(oid, prefix);
    return {
      oid,
      type: 'tree',
      object: {
        entries: treeEntriesOf(files, prefix, onTree).map((entry) => ({
          name: entry.name,
          type: entry.type,
          oid: entry.oid,
          object: entry.type === 'blob' ? { byteSize: entry.byteSize } : {},
        })),
      },
    };
  };
  const annotations = treeAt('annotations/');
  return {
    data: {
      repository: {
        ref: {
          target: {
            oid: tipOid ?? hashOf(`commit\n${annotations?.oid ?? ''}`),
            annotations,
            moderation: treeAt('annotations/moderation/'),
          },
        },
      },
      rateLimit: { ...RATE_LIMIT, remaining: 4999 },
    },
  };
}

/** `POST /graphql/snapshot` for a repository GitHub does not show. */
export function snapshotNoRepositoryDocument() {
  return { data: { repository: null, rateLimit: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] };
}

/** `POST /graphql/snapshot` for a branch that does not exist. */
export function snapshotNoBranchDocument() {
  return { data: { repository: { ref: null }, rateLimit: null } };
}

/** `POST /graphql/blobs`: each asked id's blob (`blobAt(oid)`: a file value, or null when none has it). */
export function blobsDocument(oids, blobAt) {
  const repository = {};
  oids.forEach((oid, index) => {
    const value = blobAt(oid);
    if (value === null || value === undefined) {
      repository[`b${index}`] = null;
      return;
    }
    const blob = blobOf(value);
    repository[`b${index}`] = blob.text === null
      ? { oid, byteSize: blob.byteSize, isBinary: true, isTruncated: false, text: null }
      : { oid, byteSize: blob.byteSize, isBinary: false, isTruncated: false, text: blob.text };
  });
  return { data: { repository, rateLimit: { ...RATE_LIMIT, remaining: 4990 } } };
}

/** `GET …/git/trees/<oid>`: the tree at `prefix`, as REST lists it. */
export function restTreeDocument(files, prefix, { oid = treeOidOf(files, prefix), url, onTree = null }) {
  return {
    sha: oid,
    url,
    tree: treeEntriesOf(files, prefix, onTree).map((entry) => ({
      path: entry.name,
      mode: entry.type === 'tree' ? '040000' : '100644',
      type: entry.type,
      sha: entry.oid,
      ...(entry.type === 'blob' ? { size: entry.byteSize } : {}),
    })),
    truncated: false,
  };
}

/** `GET …/git/blobs/<oid>` of a read blob. */
export function restBlobDocument(value) {
  const blob = blobOf(value);
  return { sha: blob.oid, size: blob.byteSize, encoding: 'base64', content: Buffer.from(blob.text).toString('base64') };
}

/** `GET …/contents/<path>` of a read blob. */
export function contentsDocument(value) {
  const blob = blobOf(value);
  return { type: 'file', encoding: 'base64', sha: blob.oid, content: Buffer.from(blob.text).toString('base64') };
}

/** A virtual monotonic clock: `after(ms, cb)` timers fire as `run` advances it. */
export function createVirtualTime() {
  let now = 0;
  let seq = 0;
  const timers = [];
  const after = (ms, callback) => {
    const timer = { at: now + Math.max(0, Number(ms) || 0), callback, seq: seq++ };
    timers.push(timer);
    return () => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /**
   * Settle `promise`, firing virtual timers in order whenever nothing else
   * can move (each fire advances the clock to the timer).
   */
  async function run(promise) {
    let settled = false;
    let value;
    let error;
    let failed = false;
    promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; failed = true; error = e; });
    let idle = 0;
    while (!settled) {
      await flush();
      if (settled) break;
      if (timers.length === 0) {
        idle += 1;
        if (idle > 200) throw new Error('Virtual time: the operation waits on nothing virtual and never settles');
        continue;
      }
      idle = 0;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const timer = timers.shift();
      now = Math.max(now, timer.at);
      timer.callback();
    }
    if (failed) throw error;
    return value;
  }
  return { now: () => now, after, run, get pending() { return timers.length; } };
}

/** A transport on virtual time with its own book of hosts. */
export function virtualTransport(fetchImpl, time = createVirtualTime()) {
  const epochBase = 1_800_000_000_000;
  return {
    time,
    transport: Object.freeze({
      fetch: fetchImpl,
      hosts: createHostBook({ now: time.now, after: time.after, epoch: () => epochBase + time.now() }),
      clock: new ResponseClock({ clock: time.now, after: time.after }),
    }),
  };
}

function json(document, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(document);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers },
  });
}

function errorAnswer(status, message, headers = {}) {
  return json({ error: message }, { status, headers });
}

/**
 * The in-memory GitHub. `files` (path → text, or `opaqueBlob`) seed the
 * upstream repository's branch; schemas are added unless `schemas: false`.
 */
export class MockAnnotationGitHub {
  constructor({
    owner = 'owner',
    repo = 'repo',
    branch = 'main',
    files = {},
    schemas = true,
    permissions = { pull: true, triage: false, push: true, maintain: false, admin: false },
    allowForking = true,
    user = { id: 42, login: 'researcher' },
  } = {}) {
    this.upstream = `${owner}/${repo}`;
    this.branch = branch;
    this.permissions = { ...permissions };
    this.allowForking = allowForking;
    this.user = { ...user };
    /** @type {Map<string, {files: Map<string, string|{oid: string, byteSize: number}>, parent: string|null}>} */
    this.commits = new Map();
    /** @type {Map<string, {fullName: string, fork: boolean, parent: string|null, branches: Map<string, string>}>} */
    this.repos = new Map();
    this.pulls = [];
    /** @type {Map<string, string|{oid: string, byteSize: number}>} every blob of every commit, by id */
    this._blobIndex = new Map();
    this.log = [];
    this.intercept = null;
    this.etagHits = 0;
    const initial = new Map(Object.entries({ ...(schemas ? schemaFiles() : {}), ...files }));
    this.repos.set(this.upstream.toLowerCase(), {
      fullName: this.upstream,
      fork: false,
      parent: null,
      branches: new Map([[branch, this._commit(initial, null)]]),
    });
    this.fetch = this.fetch.bind(this);
  }

  _commit(files, parent) {
    const listing = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, value]) => `${path}:${blobOf(value).oid}`).join('\n');
    const oid = hashOf(`commit\n${parent ?? ''}\n${listing}\n${this.commits.size}`);
    this.commits.set(oid, { files: new Map(files), parent });
    for (const value of files.values()) {
      this._blobIndex.set(blobOf(value).oid, value);
    }
    return oid;
  }

  _repo(owner, name) {
    return this.repos.get(`${owner}/${name}`.toLowerCase()) ?? null;
  }

  /** The files of a branch: `Map<path, text|opaque>`. */
  filesAt(fullName = this.upstream, branch = this.branch) {
    const repo = this.repos.get(fullName.toLowerCase());
    const tip = repo?.branches.get(branch);
    return tip === undefined ? null : this.commits.get(tip).files;
  }

  /** Write files on a branch as one new commit (as another contributor would). */
  commitFiles(changes, { fullName = this.upstream, branch = this.branch } = {}) {
    const repo = this.repos.get(fullName.toLowerCase());
    const tip = repo.branches.get(branch);
    const files = new Map(this.commits.get(tip).files);
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) files.delete(path);
      else files.set(path, value);
    }
    repo.branches.set(branch, this._commit(files, tip));
    return repo.branches.get(branch);
  }

  /**
   * The contributor forks the upstream on GitHub (Cellucid never does):
   * `branches` 'all' copies every branch, 'default' only the default one,
   * 'copying' none yet (GitHub still copying it).
   */
  forkOnGitHub({ login = this.user.login, name = this.upstream.split('/')[1], branches = 'all' } = {}) {
    const upstream = this.repos.get(this.upstream.toLowerCase());
    const copied = branches === 'all'
      ? new Map(upstream.branches)
      : branches === 'default'
        ? new Map([[this.branch, upstream.branches.get(this.branch)]])
        : new Map();
    const fullName = `${login}/${name}`;
    this.repos.set(fullName.toLowerCase(), { fullName, fork: true, parent: upstream.fullName, branches: copied });
    return fullName;
  }

  tipOf(fullName = this.upstream, branch = this.branch) {
    return this.repos.get(fullName.toLowerCase())?.branches.get(branch) ?? null;
  }

  /** Squash-merge an open pull request: its head's diff applied to the base as one commit. */
  squashMerge(number) {
    const pr = this.pulls.find((entry) => entry.number === number && entry.state === 'open');
    if (!pr) throw new Error(`No open pull request #${number}`);
    const head = this.filesAt(pr.headRepo, pr.headBranch);
    const headTip = this.tipOf(pr.headRepo, pr.headBranch);
    const parent = this.commits.get(headTip).parent;
    const before = parent === null ? new Map() : this.commits.get(parent).files;
    const changes = {};
    for (const [path, value] of head) {
      if (before.get(path) !== value) changes[path] = value;
    }
    for (const path of before.keys()) if (!head.has(path)) changes[path] = null;
    this.commitFiles(changes);
    pr.state = 'closed';
    return changes;
  }

  /** Whether a pull request's head applies cleanly on its base: its head commit's parent is the base tip or it only touches files the base did not change since. */
  pullRequestDiff(number) {
    const pr = this.pulls.find((entry) => entry.number === number);
    const headTip = this.tipOf(pr.headRepo, pr.headBranch);
    const parent = this.commits.get(headTip).parent;
    const base = this.filesAt(this.upstream, pr.base);
    const head = this.commits.get(headTip).files;
    const changed = [...new Set([...head.keys(), ...base.keys()])].filter((path) => head.get(path) !== base.get(path));
    return { changed, basedOnTip: parent === this.tipOf(this.upstream, pr.base) };
  }

  /** Remember a tree the mock has shown, so `GET …/git/trees/<oid>` finds it. */
  _registerTree(oid, prefix, files) {
    (this._trees ??= new Map()).set(oid, { files, prefix });
  }

  _blobByOid(oid) {
    return this._blobIndex.get(oid) ?? null;
  }

  _metadata(repo) {
    const isUpstream = repo.fullName.toLowerCase() === this.upstream.toLowerCase();
    return {
      full_name: repo.fullName,
      default_branch: this.branch,
      private: false,
      allow_forking: this.allowForking,
      permissions: isUpstream
        ? { ...this.permissions }
        : { pull: true, triage: true, push: true, maintain: true, admin: true },
    };
  }

  async fetch(rawUrl, init = {}) {
    const url = new URL(String(rawUrl));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? null : JSON.parse(init.body);
    const request = { method, path: url.pathname, query: url.searchParams, headers, body, url };
    this.log.push(`${method} ${url.pathname}${url.search}`);
    if (this.intercept !== null) {
      const answer = await this.intercept(request);
      if (answer !== undefined) return answer;
    }
    const operationId = headers.get(OPERATION_ID_HEADER);
    const mutation = (status, document) => json(document, {
      status,
      headers: { [OPERATION_ID_HEADER]: operationId, [OPERATION_OUTCOME_HEADER]: status < 300 ? 'applied' : 'not-applied' },
    });
    const mutationError = (status, message) => errorAnswer(status, message, {
      [OPERATION_ID_HEADER]: operationId,
      [OPERATION_OUTCOME_HEADER]: 'not-applied',
    });

    if (url.pathname === '/auth/user' && method === 'GET') return json(this.user);
    if (url.pathname === '/graphql/snapshot' && method === 'POST') return this._snapshot(body);
    if (url.pathname === '/graphql/blobs' && method === 'POST') return this._blobs(body);

    const match = /^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return errorAnswer(404, `Unexpected ${method} ${url.pathname}`);
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    const rest = match[3] ?? '';
    const repo = this._repo(owner, name);

    if (rest === '' && method === 'GET') {
      if (repo === null) return errorAnswer(404, 'Not Found');
      if (url.searchParams.get('fork_identity') === '1') {
        return json({
          full_name: repo.fullName,
          fork: repo.fork,
          parent: repo.fork ? { full_name: repo.parent } : null,
        });
      }
      const document = this._metadata(repo);
      const etag = `"${hashOf(JSON.stringify(document))}"`;
      if (headers.get('If-None-Match') === etag) {
        this.etagHits += 1;
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return json(document, { headers: { ETag: etag } });
    }
    if (repo === null) return method === 'GET' ? errorAnswer(404, 'Not Found') : mutationError(404, 'Not Found');

    let m;
    if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const tree = this._trees?.get(m[1]);
      if (!tree) return errorAnswer(404, 'Not Found');
      return json(restTreeDocument(tree.files, tree.prefix, {
        oid: m[1],
        url: `https://api.github.com/repos/${repo.fullName}/git/trees/${m[1]}`,
        onTree: (oid, prefix) => this._registerTree(oid, prefix, tree.files),
      }));
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const value = this._blobByOid(m[1]);
      if (value === null || blobOf(value).text === null) return errorAnswer(404, 'Not Found');
      return json(restBlobDocument(value));
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      const path = m[1].split('/').map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const files = this.filesAt(repo.fullName, url.searchParams.get('ref'));
        const value = files?.get(path);
        if (value === undefined || blobOf(value).text === null) return errorAnswer(404, 'Not Found');
        return json(contentsDocument(value));
      }
      if (method === 'PUT') {
        const files = this.filesAt(repo.fullName, body.branch);
        if (files === null) return mutationError(404, 'Branch not found');
        const current = files.get(path);
        const currentSha = current === undefined || blobOf(current).text === null ? null : blobOf(current).oid;
        if (currentSha !== null && body.sha === undefined) return mutationError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
        if (currentSha !== (body.sha ?? null)) return mutationError(409, `${path} does not match ${body.sha}`);
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        this.commitFiles({ [path]: text }, { fullName: repo.fullName, branch: body.branch });
        return mutation(200, { content: { sha: gitBlobSha(text) } });
      }
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      const tip = repo.branches.get(m[1].split('/').map(decodeURIComponent).join('/'));
      return tip === undefined ? errorAnswer(404, 'Not Found') : json({ object: { sha: tip } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const branch = body.ref.replace(/^refs\/heads\//, '');
      if (repo.branches.has(branch)) return mutationError(422, 'Reference already exists');
      if (!this.commits.has(body.sha)) return mutationError(422, 'Object does not exist');
      repo.branches.set(branch, body.sha);
      return mutation(201, {});
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const branch = m[1].split('/').map(decodeURIComponent).join('/');
      if (!repo.branches.has(branch)) return mutationError(422, 'Reference does not exist');
      if (body.force !== true) return mutationError(422, 'Update is not a fast forward');
      repo.branches.set(branch, body.sha);
      return mutation(200, { object: { sha: body.sha } });
    }
    if (rest === '/forks' && method === 'GET') {
      const page = Number(url.searchParams.get('page'));
      const forks = [...this.repos.values()].filter((entry) => entry.fork && entry.parent.toLowerCase() === repo.fullName.toLowerCase());
      return json(forks.slice((page - 1) * 100, page * 100).map((entry) => ({
        full_name: entry.fullName,
        name: entry.fullName.split('/')[1],
        owner: { login: entry.fullName.split('/')[0] },
      })));
    }
    if (rest === '/pulls' && method === 'GET') {
      const [headOwner, headBranch] = url.searchParams.get('head').split(':');
      return json(this.pulls
        .filter((pr) => pr.state === 'open' && pr.base === url.searchParams.get('base') &&
          pr.headRepo.split('/')[0].toLowerCase() === headOwner.toLowerCase() && pr.headBranch === headBranch)
        .map((pr) => ({ number: pr.number, html_url: pr.html_url })));
    }
    if (rest === '/pulls' && method === 'POST') {
      const [headOwner, headBranch] = body.head.split(':');
      const fork = [...this.repos.values()].find((entry) => entry.fullName.split('/')[0].toLowerCase() === headOwner.toLowerCase() && entry.fork);
      if (this.pulls.some((pr) => pr.state === 'open' && pr.headBranch === headBranch && pr.base === body.base)) {
        return mutationError(422, 'A pull request already exists');
      }
      const number = this.pulls.length + 1;
      const pr = {
        number,
        html_url: `https://github.com/${repo.fullName}/pull/${number}`,
        state: 'open',
        base: body.base,
        headRepo: fork.fullName,
        headBranch,
      };
      this.pulls.push(pr);
      return mutation(201, { number, html_url: pr.html_url });
    }
    return errorAnswer(404, `Unexpected ${method} ${url.pathname}`);
  }

  _snapshot({ owner, repo: name, branch }) {
    const repo = this._repo(owner, name);
    if (repo === null) return json(snapshotNoRepositoryDocument());
    const tip = repo.branches.get(branch);
    if (tip === undefined) return json(snapshotNoBranchDocument());
    const files = this.commits.get(tip).files;
    return json(snapshotDocument(files, {
      tipOid: tip,
      onTree: (oid, prefix) => this._registerTree(oid, prefix, files),
    }));
  }

  _blobs({ oids }) {
    return json(blobsDocument(oids, (oid) => this._blobByOid(oid)));
  }
}

/** A minimal valid `annotations/config.json` for `datasetId`. */
export function configFor(datasetId = 'ds', fields = ['leiden']) {
  return publishedJson({
    version: 1,
    supportedDatasets: [{
      datasetId,
      name: datasetId,
      fieldsToAnnotate: fields,
      annotatableSettings: Object.fromEntries(fields.map((field) => [field, { minAnnotators: 1, threshold: 0.5 }])),
      closedFields: [],
    }],
  });
}
