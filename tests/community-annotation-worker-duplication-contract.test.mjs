// What the community-annotation Worker and the Cellucid page must agree on has
// one home each: `worker-contract.js` (the Worker's version, route inventory,
// headers and callback fragment) and `utils/origin-allowlist.js` (the
// ALLOWED_ORIGINS rule, its loopback hosts `utils/loopback.js`
// `isSecureContextLoopbackHost`). The Worker bundles both; a
// page module imports the first instead of keeping a copy. The copies that
// cannot import are held to the shared answers here: the agent relay
// (`relay/http.js`, its own Worker) and the classic head script that takes
// the callback fragment out of the address before any module loads.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import * as contract from '../assets/js/app/community-annotations/worker-contract.js';
import { parseOriginAllowlist } from '../assets/js/utils/origin-allowlist.js';
import { isSecureContextLoopbackHost } from '../assets/js/utils/loopback.js';
import * as relayHttp from '../relay/http.js';
import { withMockedFetch } from './helpers/worker-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});
const SHARED_NAMES = Object.freeze([
  'WORKER_SERVICE',
  'WORKER_CONTRACT_VERSION',
  'CAP_WORKER_CONTRACT_VERSION',
  'WORKER_ENDPOINTS',
  'AUTH_FLAG_PARAM',
  'AUTH_TOKEN_PARAM',
  'AUTH_TOKEN_EXPIRES_PARAM',
  'AUTH_ERROR_PARAM',
]);
const SHARED_FUNCTIONS = Object.freeze(['scrubAuthFragment', 'readFragmentParamName', 'isLoopbackHostname', 'isSecureContextLoopbackHost', 'parseAllowedOrigins']);

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(path.join(ROOT, directory))) {
    const relative = `${directory}/${entry}`;
    if (statSync(path.join(ROOT, relative)).isDirectory()) yield* sourceFiles(relative);
    else if (entry.endsWith('.js')) yield relative;
  }
}

function declaredCopies(text) {
  const copies = [];
  for (const name of SHARED_NAMES) {
    if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`).test(text)) copies.push(name);
  }
  for (const name of SHARED_FUNCTIONS) {
    if (new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(text)) copies.push(name);
  }
  return copies;
}

test('the Worker answers with the shared version, identity and route inventory', async () => {
  const root = await worker.fetch(new Request('https://worker.example/'), ENV);
  assert.deepEqual(await root.json(), {
    status: 'ok',
    service: contract.WORKER_SERVICE,
    contractVersion: contract.WORKER_CONTRACT_VERSION,
    endpoints: [...contract.WORKER_ENDPOINTS],
  });
  await withMockedFetch(async () => new Response('{"data":{"lookupCells":[]}}', { status: 200 }), async () => {
    const lookup = await worker.fetch(new Request('https://worker.example/cap/lookup-cells', {
      method: 'POST',
      headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' },
      body: '{"kind":"name","term":"T cell","limit":1}',
    }), ENV);
    assert.equal((await lookup.json()).contractVersion, contract.WORKER_CONTRACT_VERSION);
  });
});

test('the Worker keeps no copy of what it shares', () => {
  const source = read('assets/js/app/community-annotations/_worker-code.js');
  assert.deepEqual(declaredCopies(source), []);
  assert.match(source, /from '\.\/worker-contract\.js'/);
  assert.match(source, /from '\.\.\/\.\.\/utils\/origin-allowlist\.js'/);
});

test('page modules take the Worker contract from worker-contract.js instead of copying it', () => {
  const copies = {};
  for (const directory of ['assets/js/app/community-annotations', 'assets/js/app/ui/modules/community-annotation']) {
    for (const file of sourceFiles(directory)) {
      if (file.endsWith('/worker-contract.js') || file.endsWith('/_worker-code.js')) continue;
      const found = declaredCopies(read(file));
      if (found.length !== 0) copies[file] = found;
    }
  }
  assert.deepEqual(copies, {}, 'import these from app/community-annotations/worker-contract.js');
});

test('the operation headers a page module names are the Worker\'s', async () => {
  for (const file of sourceFiles('assets/js/app/community-annotations')) {
    const text = read(file);
    for (const [name, value] of [
      ['OPERATION_ID_HEADER', contract.OPERATION_ID_HEADER],
      ['OPERATION_OUTCOME_HEADER', contract.OPERATION_OUTCOME_HEADER],
    ]) {
      const declared = new RegExp(`\\bconst\\s+${name}\\s*=\\s*'([^']*)'`).exec(text);
      if (declared !== null) assert.equal(declared[1], value, `${file} ${name}`);
    }
  }
});

test('the head script takes out exactly the callback fragment\'s fields', () => {
  const script = read('assets/js/app/ui/core/auth-fragment-init.js');
  const literal = /\/\^#\(\?:\.\*&\)\?cellucid_github_\(\?:([a-z_|]+)\)=\//.exec(script);
  assert.ok(literal, 'the head script names the fields in one pattern');
  const named = literal[1].split('|').map(suffix => `cellucid_github_${suffix}`).sort();
  assert.deepEqual(named, [
    contract.AUTH_FLAG_PARAM,
    contract.AUTH_TOKEN_PARAM,
    contract.AUTH_TOKEN_EXPIRES_PARAM,
    contract.AUTH_ERROR_PARAM,
  ].sort());
});

test('the agent relay\'s loopback hosts and ALLOWED_ORIGINS rule answer as the shared ones', () => {
  for (const hostname of [
    'localhost', 'LOCALHOST', 'a.localhost', 'a.b.localhost', '127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.255',
    '[::1]', '::1', '0.0.0.0', '128.0.0.1', '[::2]', '[::ffff:7f00:1]', 'localhost.example', 'localhost.evil.com',
    'example.com', '127.0.0.1.example', '127.0.0.1.nip.io', 'xlocalhost', 'localhost.', '',
  ]) {
    assert.equal(relayHttp.isSecureContextLoopbackHost(hostname), isSecureContextLoopbackHost(hostname), hostname);
  }
  const bindings = { idFromName() {} };
  const relayAnswer = raw => {
    try {
      return [...relayHttp.relayEnvironment({
        RELAY_SIGNING_KEY: 'k'.repeat(43),
        ALLOWED_ORIGINS: raw,
        PAIRING: bindings,
        APPROVAL: bindings,
      }).allowedOrigins];
    } catch (error) {
      assert.equal(error.status, 500);
      return 'refused';
    }
  };
  const sharedAnswer = raw => {
    try {
      return [...parseOriginAllowlist(raw, message => Object.assign(new Error(message), { status: 500 }))];
    } catch (error) {
      assert.equal(error.status, 500);
      return 'refused';
    }
  };
  const corpus = [
    'https://app.example',
    'https://app.example,http://localhost:8000',
    'https://app.example, http://localhost:8000',
    'https://app.example/',
    'http://app.example',
    'http://127.0.0.1:8000',
    'http://127.255.0.1',
    'http://[::1]:3000',
    'http://a.localhost',
    'http://0.0.0.0:8000',
    'http://192.168.1.5',
    '*',
    '',
    ',',
    'https://a.example,',
    'https://a.example,https://a.example',
    'https://user:pw@a.example',
    'HTTPS://A.EXAMPLE',
    'https://a.example:443',
    'https://a.example:8443',
    'https://xn--bcher-kva.example',
    'https://bücher.example',
    'https://a.example?x',
    'https://a.example#x',
    'file:///x',
    'ftp://a.example',
  ];
  let accepted = 0;
  for (const raw of corpus) {
    const shared = sharedAnswer(raw);
    assert.deepEqual(relayAnswer(raw), shared, JSON.stringify(raw));
    if (shared !== 'refused') accepted += 1;
  }
  assert.ok(accepted >= 5 && accepted < corpus.length);
});
