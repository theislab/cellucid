/**
 * A link that is itself the key to its file (a OneDrive or SharePoint
 * sharing link, a Figshare private link) is shown by its public form from
 * the first moment anything names it: the opening's title, every step said
 * while it resolves, a refusal's message and details. The rule is the
 * registry's, not each provider's: every provider states what may be shown
 * of its values (`publicValue`), and whatever is said while a link resolves
 * goes through it (`link-source.js`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataSourceError, DataSourceErrorCode } from '../assets/js/data/data-source.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { getOpeningProgress } from '../assets/js/data/opening-progress.js';
import { DEFAULT_PROVIDERS, ProviderRegistry, getProviderRegistry, requireProvider } from '../assets/js/data/sources/registry.js';

const SECRET = 'SECRETSHAREKEY';

test('every provider states what may be shown of its values; a share link is never one of them', () => {
  for (const provider of DEFAULT_PROVIDERS) assert.equal(typeof provider.publicValue, 'function', provider.id);
  const { publicValue: _omitted, ...withoutPublicForm } = DEFAULT_PROVIDERS.find(provider => provider.id === 'zenodo');
  assert.throws(() => requireProvider(withoutPublicForm), /needs publicValue/);
  const registry = getProviderRegistry();
  for (const link of [
    `https://1drv.ms/u/s!${SECRET}?e=abc`,
    `https://1drv.ms/f/s!${SECRET}`,
    `https://onedrive.live.com/:x:/g/personal/x/${SECRET}?e=1`,
    `https://figshare.com/s/${SECRET}`,
  ]) {
    const resolved = registry.resolve(link);
    assert.ok(!resolved.publicLocator.includes(SECRET), `${link} → ${resolved.publicLocator}`);
    // The share id is the link in base64url: not shown either.
    assert.ok(!resolved.publicLocator.includes(resolved.value), `${link} → ${resolved.publicLocator}`);
    assert.ok(!registry.publicFormOf(link).includes(SECRET));
  }
  assert.equal(registry.publicFormOf(`https://1drv.ms/u/s!${SECRET}`), 'onedrive:share:1drv.ms');
  assert.equal(registry.publicFormOf('https://onedrive.live.com/?cid=ABC&id=ABC%21123'), 'onedrive:abc/ABC!123', 'a drive and item grant nothing without a sign-in');
});

test('the opening of a key-carrying link names it by its public form from its first moment: title, steps, refusal', async t => {
  // A provider whose value is its key, which says it in every step and in its refusal.
  const sharing = {
    id: 'share',
    label: 'Share',
    capabilities: { folders: false, private: 'link', public: false, versions: false, write: false },
    match: input => (input.startsWith('https://share.example.org/') ? `key!${input.slice('https://share.example.org/'.length)}` : null),
    publicValue: value => (value.startsWith('key!') ? 'key!…' : value),
    async open(value, { onStep }) {
      onStep(`Reading ${value} from Share`);
      throw new DataSourceError(`"${value}" names no file Share keeps.`, DataSourceErrorCode.NOT_FOUND, 'link', { input: value });
    },
  };
  const said = [];
  const stop = getOpeningProgress().subscribe(snapshot => {
    for (const opening of [snapshot].flat().filter(Boolean)) said.push(JSON.stringify(opening));
  });
  t.after(stop);
  const source = new LinkDataSource({ registry: new ProviderRegistry([sharing]) });
  await assert.rejects(source.connect(`https://share.example.org/${SECRET}`), error => {
    assert.ok(!error.message.includes(SECRET), error.message);
    assert.ok(!JSON.stringify(error.details ?? {}).includes(SECRET), JSON.stringify(error.details));
    assert.match(error.message, /"share:key!…" names no file Share keeps\.|"key!…" names no file Share keeps\./);
    return true;
  });
  source.disconnect();
  assert.ok(said.length > 0, 'the opening was shown');
  for (const line of said) assert.ok(!line.includes(SECRET), line);
  assert.ok(said.some(line => line.includes('Reading key!… from Share')), 'its steps are said in the public form');
});
