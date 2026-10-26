/**
 * The Session panel's Open data controls: one "Open…" button for every local
 * dataset, and one address bar for links and servers.
 *
 * A browser's file dialog picks files or one folder, never both, so the
 * button opens a two-item menu (File… for an `.h5ad` or a `.zarr.zip`, Zarr
 * folder… for a `.zarr` store), the same for every browser. What was picked
 * decides how it is read.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { collectDOMReferences } from '../assets/js/app/ui/core/dom-cache.js';
import {
  describeHiddenMetadataProblem,
  shortAddress,
} from '../assets/js/app/ui/modules/dataset-connections.js';
import { localFileLayout } from '../assets/js/app/ui/modules/dataset-drop.js';
import { filePickerAccept } from '../assets/js/data/input-formats.js';
import { routeAddress } from '../assets/js/app/ui/modules/address-routing.js';
import { infoTipText } from './helpers/info-tip-text.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const indexHtml = await read('../index.html');
const connectionSource = await read('../assets/js/app/ui/modules/dataset-connections.js');
const sessionCss = await read('../assets/css/components/_session.css');

function tag(pattern, label) {
  const match = indexHtml.match(pattern)?.[0];
  assert.ok(match, `${label} is required`);
  return match;
}

test('one Open… button opens a File… / Folder… menu, the same in every browser', () => {
  const button = tag(/<button\b[^>]*id="user-data-open-btn"[^>]*>[^<]*<\/button>/, 'Open… button');
  assert.match(button, />Open…<\/button>/);
  assert.match(button, /\baria-haspopup="menu"/);
  assert.match(button, /\baria-controls="user-data-open-menu"/);
  assert.match(button, /\bdisabled\b/, 'it ships disabled until its listeners exist');

  const menu = tag(/<div\b[^>]*id="user-data-open-menu"[^>]*>[\s\S]*?<\/div>/, 'Open… menu');
  assert.match(menu, /\brole="menu"/);
  assert.match(menu, /\bhidden\b/);
  const items = [...menu.matchAll(/<button\b[^>]*role="menuitem"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(match => match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  assert.deepEqual(items, ['File… AnnData, Seurat/SCE .rds/.rda, Loom, 10x .h5, .h5mu', 'Folder… Zarr, 10x outs, MatrixMarket']);

  const fileInput = tag(/<input\b[^>]*id="user-data-file-input"[^>]*>/, 'file input');
  assert.match(fileInput, /\btype="file"/);
  // File… takes every single-file format of the registry, set when the
  // control is wired, so the list has one source.
  assert.doesNotMatch(fileInput, /\baccept=/);
  assert.match(connectionSource, /userDataFileInput\.accept = filePickerAccept\(\);/);
  assert.equal(filePickerAccept(), '.h5ad,.zip,.loom,.h5,.h5mu,.rds.gz,.rds,.rdata.gz,.rda.gz,.rdata,.rda,.h5seurat');
  assert.doesNotMatch(fileInput, /\b(?:webkitdirectory|directory|multiple)\b/);
  const folderInput = tag(/<input\b[^>]*id="user-data-folder-input"[^>]*>/, 'folder input');
  assert.match(folderInput, /\bwebkitdirectory\b/);

  // No control per format, and no browser sniffing.
  assert.doesNotMatch(indexHtml, /user-data-(?:h5ad|zarr-archive|zarr-folder)-(?:btn|input)/);
  assert.doesNotMatch(connectionSource, /navigator\.(?:userAgent|userAgentData|vendor)/);
  // One row: the button spans the sidebar.
  assert.match(sessionCss, /\.open-menu-button\s*\{[^}]*width:\s*100%/);
});

test('a picked file is read by what it is', () => {
  assert.equal(localFileLayout({ name: 'cells.h5ad' }), 'file');
  assert.equal(localFileLayout({ name: 'cells.H5AD' }), 'file');
  assert.equal(localFileLayout({ name: 'cells.zarr.zip' }), 'zip');
  assert.equal(localFileLayout({ name: 'cells.zip' }), 'zip');
  assert.equal(localFileLayout({ name: 'cells.csv' }), null);
});

test('the File or folder tip names every kind and that nothing is uploaded', () => {
  const tipText = infoTipText(indexHtml, 'user-data-info-tooltip');
  for (const kind of [/\.h5ad/, /\.zarr\.zip/, /\.zarr/, /drop/i, /nothing is uploaded/i]) {
    assert.match(tipText, kind);
  }
});

test('the DOM cache names the Open… menu and the address bar', () => {
  const dom = collectDOMReferences({ getElementById: id => ({ id }) });
  assert.deepEqual(
    Object.fromEntries(Object.entries(dom.dataset).map(([key, value]) => [key, value.id])),
    {
      select: 'dataset-select',
      userDataOpenBtn: 'user-data-open-btn',
      userDataOpenMenu: 'user-data-open-menu',
      userDataFileItem: 'user-data-file-item',
      userDataFolderItem: 'user-data-folder-item',
      userDataFileInput: 'user-data-file-input',
      userDataFolderInput: 'user-data-folder-input',
      datasetDropOverlay: 'dataset-drop-overlay',
      dataAddressInput: 'data-address',
      dataAddressOpenBtn: 'data-address-open-btn',
      remoteDisconnectBtn: 'remote-disconnect-btn',
      remoteDisconnectContainer: 'remote-disconnect-container',
      remoteConnectionTarget: 'remote-connection-target',
      dataLinkDisconnectBtn: 'data-link-disconnect-btn',
      dataLinkDisconnectContainer: 'data-link-disconnect-container',
      dataLinkConnectionTarget: 'data-link-connection-target',
    }
  );
});

test('the address bar routes what is typed the same way every time', () => {
  const routes = {
    '8765': { kind: 'server', url: 'http://localhost:8765' },
    'localhost:8765': { kind: 'server', url: 'http://localhost:8765' },
    '127.0.0.1:9000/': { kind: 'server', url: 'http://127.0.0.1:9000' },
    'lab-server:8765': { kind: 'server', url: 'http://lab-server:8765' },
    'http://localhost:8765/': { kind: 'server', url: 'http://localhost:8765' },
    'https://example.org/data/cells.h5ad': { kind: 'link', value: 'https://example.org/data/cells.h5ad' },
    'https://example.org/data/cells.zarr/': { kind: 'link', value: 'https://example.org/data/cells.zarr/' },
    'https://example.org/data/datasets.json': { kind: 'link', value: 'https://example.org/data/datasets.json' },
    'https://example.org/f?token=1': { kind: 'link', value: 'https://example.org/f?token=1' },
    'hf:user/repo': { kind: 'link', value: 'hf:user/repo' },
    'zenodo:123': { kind: 'link', value: 'zenodo:123' },
    'GSE123456': { kind: 'link', value: 'GSE123456' },
    'owner/repo/path': { kind: 'link', value: 'owner/repo/path' },
    'https://zenodo.org/records/1': { kind: 'link', value: 'https://zenodo.org/records/1' },
    // Only what answers there can tell a server from a folder of datasets.
    'https://lab.example.org/catalog/': {
      kind: 'ask',
      url: 'https://lab.example.org/catalog',
      value: 'https://lab.example.org/catalog/',
    },
  };
  for (const [typed, expected] of Object.entries(routes)) {
    assert.deepEqual({ ...routeAddress(typed) }, expected, typed);
  }
  assert.equal(routeAddress('   ').kind, 'invalid');
  assert.match(routeAddress('localhost:99999').message, /not a port/);
});

test('a folder listed without its hidden files says how to open it instead', () => {
  const listed = paths => paths.map(path => ({ name: path.split('/').at(-1), webkitRelativePath: path }));
  // Safari's folder dialog: a v2 store without .zgroup, .zattrs, .zmetadata.
  assert.match(
    describeHiddenMetadataProblem(listed(['cells.zarr/X/0.0', 'cells.zarr/obs/_index/0'])),
    /left out the folder's hidden files.*Drag the folder onto the page, or open its \.zarr\.zip\./
  );
  // Every other listing goes on to the reader, which says what it lacks.
  assert.equal(describeHiddenMetadataProblem(listed(['cells.zarr/.zgroup', 'cells.zarr/X/0.0'])), null);
  assert.equal(describeHiddenMetadataProblem(listed(['cells.zarr/zarr.json', 'cells.zarr/X/c/0/0'])), null);
});

test('a connection line names its address in one short line', () => {
  assert.equal(shortAddress('http://localhost:8777'), 'localhost:8777');
  assert.equal(
    shortAddress('https://theislab.github.io/cellucid-demo-custom-datasets/catalog/'),
    'theislab.github.io/…/catalog/'
  );
  assert.equal(shortAddress('https://example.org/cells.h5ad'), 'example.org/cells.h5ad');
  assert.equal(shortAddress('hf:user/repo'), 'hf:user/repo');
  assert.equal(shortAddress('GSE123456'), 'GSE123456');
});
