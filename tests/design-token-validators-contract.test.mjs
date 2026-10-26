/**
 * The two design-token validators `assets/css/README.md` names run with the
 * contract suite. Neither ran anywhere, and `types/design-tokens.d.ts` had
 * drifted from the token files by sixteen names (six tokens missing, ten
 * that no longer exist), with two dead sidebar bounds that disagreed with
 * the bounds the sidebar is actually clamped to.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

for (const script of ['scripts/validate-tokens.js', 'scripts/validate-token-types.js']) {
  test(`${script} passes`, () => {
    // A run takes about a second; one still running after a minute is hung
    // (see design-token-validator-contract) and is killed, failing here with
    // its output instead of holding the suite.
    const run = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.signal, null, `${script} did not end:\n${run.stdout}\n${run.stderr}`);
    assert.ifError(run.error);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  });
}

test('opacities come from the opacity scale', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const offenders = [];
  for (const folder of ['components', 'layouts', 'base', 'utilities']) {
    const directory = path.join(ROOT, 'assets', 'css', folder);
    for (const name of readdirSync(directory).filter(file => file.endsWith('.css'))) {
      readFileSync(path.join(directory, name), 'utf8').split('\n').forEach((line, index) => {
        if (/(^|[\s;{])opacity:\s*0?\.\d+\s*;/.test(line)) offenders.push(`${folder}/${name}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});
