/**
 * Action versions (History v2 §3.8, owner decision 2026-11-04: old history
 * files keep replaying). Every action whose steps are recorded has a
 * `version` of its parameters and an upgrader from each earlier one (a read
 * or a move of the history records no step and has none); a step records
 * the version it was made with (`Step.v`); every version keeps its shape and
 * examples using every property and every `oneOf` branch
 * (`tests/fixtures/action-versions/<type>@<version>.json`,
 * `scripts/generate-action-versions.mjs`). A params shape that changes
 * without a version bump and an upgrader fails here (rewording does not);
 * so does an older example that no longer upgrades to valid parameters, and
 * a file whose bytes are not the pinned ones (deleted and written again).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogDocument, createActionCatalog, defineAction, isSteplessEffect, upgradeParams } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { examplesOf } from '../assets/js/app/actions/schema.js';
import {
  readVersionFiles, renderVersionExample, versionFileDigests, versionFileName, versionProblems,
} from '../scripts/generate-action-versions.mjs';

/**
 * The bytes of every version file (`node scripts/generate-action-versions.mjs
 * --digests`). A file is written once and kept: one that changes was deleted
 * and written again, or edited, which would lose what its version was. A new
 * action or version adds its line.
 */
const VERSION_FILES = Object.freeze({
  'analysis.close@1.json': '5b2d435ea7d226c9951864d8f09a173b20dd8e2f83d06dcc7d905a94c4c5160f',
  'analysis.composition.set@1.json': '0be67264386cd8c1f7c87459f8bd9f62b9253a89676e22b0469ff211dbbd7b00',
  'analysis.correlation.set@1.json': 'dedc00605a94d9d0c7a13f33c7af3f2b3dd84fe947a09cca3fe0168e07aa11b8',
  'analysis.detailed.set@1.json': 'b81ade25c5203c32fc7a36c6558e1622848991e53c121572fb4754aede04aecc',
  'analysis.differential.set@1.json': 'da423c2c0b536b7b13cc673cd3a84aebc3d80ab05e85000732e40ac8d55374f1',
  'analysis.dotplot.set@1.json': 'bfc7a029f71373aacbdcacbcdf0c40c761c1af4d0d0b185b4f16509d79efe6ca',
  'analysis.markers.set@1.json': '0f1adb5bffece61d2f39c2aa36cc1b108c79e8969a77b86fdd86ad01e50eb227',
  'analysis.open@1.json': '51e6731fd34c3b2da9034beac7f4d6bc19fba210c30f3a07e1fa54f191544770',
  'analysis.pages.set@1.json': 'f989172c0b7c4f9dbe53ecf28de8edfbfc910bee21e4249327bab96fe59933b4',
  'analysis.quick.set@1.json': '1a5320ba9dff44c7e152a513b3fc936406c3f048d5057ce263663149e58c5453',
  'analysis.run@1.json': 'b1564e9263b6b034df437b90484accb7ed7e64536ee90197c7f3b7b5d5fd0548',
  'analysis.signature.set@1.json': '6b06a4523465fb7e5371a515363b669e1ef5ba46e3de341ca2aca876e7605a20',
  'analysis.size.set@1.json': '1c502bbc25034e495fe896d7a5db0112787e495da1e888890d0304d2dc175da7',
  'analysis.view.set@1.json': 'd8b8dbbbbd05daad2d382f65bacd99bc41bb99abc60312b54950850c345fb8ce',
  'analysis.window.close@1.json': '2bf6b053430391fcf73c04bc60f258cb21b7ca14fb8bc4024ea85ba0539e50b2',
  'analysis.window.collapse@1.json': '036b08eb7a606f3ccee3556dd064a1dd43d5cf8d697edaa5f0144e8d415365ec',
  'analysis.window.copy@1.json': '4c9b1062c158fe16c6458a224100c013d20ea0e7d2c572998d5b324e470ef5a1',
  'analysis.window.place@1.json': '6abfc36a83af4e965fca297bf4180ebe2a8f79143a5e8a82cf344122311367b8',
  'camera-path.clear@1.json': '86e4432aa5a9c104aeb6c60820cc4229dd420012d373170e2617b749a966877a',
  'camera-path.duration.set@1.json': '6e90aa498a050aedf59f5e2ba3ca2b0d8b67800ed30ca9763dfb0c04070ca8dd',
  'camera-path.keyframe.add@1.json': '8c8a0d4e2b69e60661f7a882564008107b6b214c55c7bbfb8083c78c14fea05d',
  'camera-path.keyframe.move@1.json': '8c840cbed2a1622c948980c51ce58da39ebb69ce07b9a638f1d8abd4d50a9cdb',
  'camera-path.keyframe.remove@1.json': '35a242846ef2f57d0ae1d063c66e630a7a52fc71b1f7cd49f95fe7c636885c24',
  'camera-path.keyframe.rename@1.json': '6bbd553af7e67995b45808315d09ba00daca890473ae07e866d5e767a9b91774',
  'camera-path.loop-back.set@1.json': '7c58a2fc6dd8a8c3405e3bb343feaacf214efea48511ab8692900c4550339591',
  'camera-path.playback.set@1.json': '8cd0d38f7545f973bbf080791a250bed32feac1eb78ad9bf3ff12f8deaaeea39',
  'camera.navigation.set@1.json': '19b7c62b66ac5d81161e7f8ef0940357b8657e5fcb4d7f1b7a41c76103df15d8',
  'camera.reset@1.json': 'f23bcf94059af34e6c70f18e412e388aa2405f48304708d620e01b042e1f9b5b',
  'camera.set@1.json': '1d7f99caa8913402598fd210488a467c3de807506a1235a9973cccdfc52ec6cf',
  'category.delete@1.json': '9975b4f99a05aac47f42192cc2ad6986c312b2921b32f2c98958fecc2e14c7ca',
  'category.merge@1.json': 'c4ed1a32af2b66b22c1c278974f179cbdcbd0216c7742f9d9736b498f700f29a',
  'category.rename@1.json': '23cc3b276471a79182dde818a7f43508563f1c1a21edd1a90a22f90384fa10e0',
  'cells.open@1.json': '6e28351e2245a3a6e06a29aed5904c10e87acc6a926f0ae764bde08f922663b2',
  'cells.read-genes@1.json': '4495e5c1739f8cc8b5e462e09d537c1ff280fbb2f7c008249626c388f3756ac9',
  'cells.visibility.set@1.json': '83d8a5cc3b6465a842677c302423cfe1209e864e025da914e5404f89ca93bf5b',
  'color.by@1.json': 'fa14cc74de7f73fe8342a56807d69769005086f2667ec55ac65a2f9a9170e7e0',
  'color.category@1.json': '5741c6904c43a2692c011731eebd4ea8133240196e9378c61288d6ec88a7b9c0',
  'color.continuous.colormap@1.json': 'a29f714b3036ef913f5876ae084848995fcfc13aa5689ec79b5ad9d7894cc929',
  'color.continuous.log@1.json': '6d3873e970485bcd6b47f516646407de97ab3af3b7c6e70d3aa144a131980910',
  'color.continuous.range@1.json': 'ad85f82fe423eb95010ee74706478716cefee16a974b9838da2aeb835c4a21af',
  'color.continuous.rescale@1.json': 'e35a736fcac9e9e8f64d8a531ed8c677bb0432587d051a16ec1759c08b1ac03d',
  'color.continuous.zero-gray@1.json': '84b91a2b976be227d8d99da1bc8771e30c9005002bb864228ba1becb953e6f78',
  'display.reset@1.json': '5a13a8ac5dbde0743318ca79c050a1ed9a8fac20b1404c47f8853a0faa104f59',
  'field.consensus@1.json': '184ebff2e38828b09e689f663dabff23ce24e925ba6a206cad87b6f632f19ebd',
  'field.consensus@2.json': '46dab8cd5fa6d2ec3e9f36fcff07342c2e9469cf2cb4ea00c0b18fc20d2643db',
  'field.create-from-pages@1.json': '3ff9a0679fc767da863d77366cf105b293989499d987ddf91463670b4917d260',
  'field.delete@1.json': '9485f15a7e54172dad01c7dce398fa2640dd80427e597f2a1db843122e1a4ab4',
  'field.duplicate@1.json': '83126d388a41d5d8620968f6780a453b8f78a49a8e1ed3a061385bcc675006e2',
  'field.purge@1.json': 'a14401b2a3762e6faebdddf75f521500f3770a3fb1fb8fd7face53f86eb16e17',
  'field.push@1.json': '1ee11c2a437e9911d6a6b9068edca4c36760ebad4b9afbc66e27a1b80cc67663',
  'field.rename@1.json': 'c8f2c6c6c1e7914811ce695e764c58b0356fb109c6229f018b837988ac6a1e9f',
  'field.restore@1.json': '92f9ac9c419959842883a8e01eebc13b50adf0c2fcc3420aecfda201898e4710',
  'field.revert-name@1.json': 'bcabd65edb1e9abfa4b64c420b998c63793ec3ff36dbf8851abd9dcffad72690',
  'figure-export.set@1.json': '59e04f98442cc2cde9a320c6595f3650ac7cb21e97835385943f49a49debbed3',
  'filter.category.all@1.json': '0162abcadcdfe7253e5a59399b192b1e86191b910ca4f988389f41d1a882bec3',
  'filter.category.cell-count@1.json': '46e635d5d401112ded2d131da93df1a3fc088995620afd3c1604140d75e6299d',
  'filter.category.missing@1.json': '7c1a0b61b91ac3038802f45bc2d7ba256120e44251cbfcf4b43f0b13186d5835',
  'filter.category.visibility@1.json': '29a36a60b0cde8746ac9776bef6f540ff322c1c7579fdf6eabf1389c58c88dd9',
  'filter.continuous.range@1.json': 'cfa5f39d69f63db6ac64cdfd5860a4979d93813b3d1e1cdd1f101e2a00320116',
  'filter.continuous.reset@1.json': '56c4229447e49a2b78f633c3c9b2254e4c829f7fa3db0f33cf12868b66d631ef',
  'filter.enable@1.json': 'eb2052c47051b048ecb5e5d7354f4e8ac557b3c8517c059f389d86fd624e525f',
  'filter.outlier@1.json': '812378f95fd07c158d99b28b8eb44125753457b562f78cbd7479ba5d64ba13a7',
  'filter.remove@1.json': '502d6f168933ffc742a65cfcb1cacbd29dd7cf4eaa3bf3438d272e36ca12a48f',
  'gene-set.save@1.json': '5a82b0533cf273a0829374a59db4e6d3541bb269b060afdfce57df92b4be635e',
  'highlight.category@1.json': '438a346b7361ef08f5b399190441601ad1f6d06c6ef3e9f87b381d2c5338c714',
  'highlight.cells@1.json': 'd7c049a98c8b4f5930d795935fdaddd4b9555d010a61c0f6b8ba9eaae1208c9e',
  'highlight.clear-all@1.json': '1544e498501476821bc213d2cf788a8679ec8e8145ab70024cd76abfb14636e0',
  'highlight.group.remove@1.json': '7c082b51a9aa043e16e6375bf72edf2111931301d189188bf999bde6776dbb51',
  'highlight.group.toggle@1.json': '66facc11832218f502b54637ff0c4c6d34b909f18e878ee1047f0cb2aee23072',
  'highlight.page.clear@1.json': 'f1b461f1384fe132c95f36ec97a7f0287c8a09879e1950a8b661135e2ee510c0',
  'highlight.page.combine@1.json': '6fb3347d62fdbeebe83983de0fca8ef3984fb595ece2b8b68072e9ebd6906cdb',
  'highlight.page.create@1.json': 'dfc29f1385940b2c22c5146f5569440f75b4ade2d3c41838d6924d7cb43b6985',
  'highlight.page.delete@1.json': '58d145bce59b611b41ea10fa34e1a03926d83fd8ec3264201a4010e83ea0f65f',
  'highlight.page.recolor@1.json': '40952950a0a1ef298919ef57c0c28c89f3cc6fbfcbfb5ab7cac6986d04a6d395',
  'highlight.page.rename@1.json': 'c43f30cfeaf0bc942451e100f62863fb520109bc3f86d0436da759a0c9111567',
  'highlight.page.switch@1.json': 'd2ff3d9a78321a62fbc14e130810618888cdb6a6c6e5d73cde12f798c8aa7a9b',
  'highlight.range@1.json': 'bbbf5d3527f12e14ea0b6d263311673343e8cd1274f7b8da60e32be823bb1768',
  'history.step.revert@1.json': '1e7dd9125c9a99c62562426836dec2b0e1bef885ee40c0971e799819192dca47',
  'layout.panel.dock@1.json': '6a1098d593a050b2e2cb16d00f0439b6e68082c673fb050b09e7449151373061',
  'layout.panel.float@1.json': 'cb0757e971196a572f1c718deac5b9f123bc6c81b3cecf46e61148c2356ad041',
  'layout.panel.place@1.json': '40338f5deb3d83f69258ceda9b8fc081a3ffdeeb700ef3916e87f69480d4985b',
  'layout.section.open@1.json': 'a290f00953687facc637aef1553d4ba3bd512ca518891b4be49510b23453f33c',
  'layout.sidebar.show@1.json': 'bae6d33096d0d40ca1a701da5d157cedeb98bb19248f677af4b92a74330d4468',
  'layout.sidebar.width@1.json': '14b02099041aba91c92a5ad00841546620e0bd6dd256c1d0f9af86289d0b9967',
  'layout.theme.set@1.json': '7e8c244a04d3922526b189632ecdc95c02d9ef679ea83371711bdbb13c7d911a',
  'mapping.set@1.json': '3410d8b33cdb6ec21fe9c9c8ca6a342bd60eaa5130c3e6009baa1a17186a510e',
  'setting.set@1.json': 'f531e81aded15491141ed76c25b0f25dba5678a32f84e82534081f572e38b6dc',
  'view.cameras.link@1.json': 'c85551e6c615d9ff5b60924235dd2536f308da5e9697ee5e2a3c8bacc99a5555',
  'view.clear@1.json': '4c5d9031726f67f33e03c28651b5cf12ab9874517dae71f3256297430460b08d',
  'view.embedding.cycle@1.json': '354b3d96175bda33c92ad282847aea26fd856b578790dbd962ca875c71ea8201',
  'view.embedding.default@1.json': 'b1e36eb6fc2ae448d2807abc6714f6c90bee700681cd9826667e4a04c1c8494b',
  'view.embedding.set@1.json': '1cd92419ffe3fbbee90fbfd8f40e51a83205a1e5c8bb90bed1454ee36eea086d',
  'view.focus@1.json': '215915d0f062244b7cd83cc62d2bf58b2d47ae8d57436163e93aeb97ca5ec3b6',
  'view.keep@1.json': '9542a41df7420dbe8f96a81e8e041c876e99d58c25dcd1acb0f4ee127977a606',
  'view.layout.set@1.json': '813c28056013e02df5b66efcd8ae98f3cc0cebcd9c467e56a566342380bd4aba',
  'view.remove@1.json': '3b1980d709a8a7f9b8a90761c1f6a2d4a4eca2d5bb091bf2f35dff291825dd1d',
});

test('every version of every action keeps its example, and the parameters now are the current version\'s', () => {
  const problems = versionProblems(ACTION_DEFINITIONS, readVersionFiles());
  assert.deepEqual(problems, [], problems.join('\n'));
  const files = readVersionFiles();
  const expected = createActionCatalog(ACTION_DEFINITIONS).list().filter(definition => definition.version !== null)
    .flatMap(definition => Array.from({ length: definition.version }, (_, index) => versionFileName(definition.type, index + 1)));
  assert.deepEqual(files.map(file => file.name).sort(), expected.sort(), 'one file per version of each recorded action, and no other');
  assert.deepEqual(versionFileDigests(files), VERSION_FILES, 'the kept files are the pinned bytes (node scripts/generate-action-versions.mjs --digests)');
  for (const definition of createActionCatalog(ACTION_DEFINITIONS).list()) {
    assert.equal(definition.version === null, isSteplessEffect(definition.effect), `${definition.type}: versioned exactly when its steps are recorded`);
  }
});

const BASE = Object.freeze({
  type: 'test.color', title: 'Colour', summary: 'Colour by a field.', group: 'Test',
  params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string', minLength: 1 } } },
  touches: ['active-field'], reads: [], effect: 'view', describe: () => 'Coloured', code: () => 'color()',
});

/** The same action, its `field` now `{source, key}`: version 2, with the upgrader from 1. */
const V2 = Object.freeze({
  ...BASE,
  params: {
    type: 'object', additionalProperties: false, required: ['field'],
    properties: {
      field: {
        type: 'object', additionalProperties: false, required: ['source', 'key'],
        properties: { source: { enum: ['obs', 'var'] }, key: { type: 'string', minLength: 1 } },
      },
    },
  },
  version: 2,
  upgrade: { 1: params => ({ ...params, field: { source: 'obs', key: params.field } }) },
});

function keptFile(definition) {
  const text = renderVersionExample(definition);
  return { name: versionFileName(definition.type, definition.version), type: definition.type, version: definition.version, record: JSON.parse(text), text };
}

test('a params schema changed without a version bump and an upgrader fails, naming what to do', () => {
  const v1 = defineAction(BASE);
  const kept = [keptFile(v1)];
  assert.deepEqual(versionProblems([v1], kept), []);
  // Rewording a description is no new version.
  const reworded = defineAction({ ...BASE, params: { ...BASE.params, properties: { field: { type: 'string', minLength: 1, description: 'The field.' } } } });
  assert.deepEqual(versionProblems([reworded], kept), []);
  // The parameters changed, the version did not.
  const changed = defineAction({ ...V2, version: undefined, upgrade: undefined });
  assert.deepEqual(versionProblems([changed], kept), [
    'The parameters of "test.color" changed at version 1: bump its version to 2, add upgrade[1] (parameters of version 1 to 2), '
      + 'and run node scripts/generate-action-versions.mjs to keep examples of the new version',
  ]);
  // Bumped, with its upgrader: the new version needs its own example, and then the old one replays.
  const v2 = defineAction(V2);
  assert.deepEqual(versionProblems([v2], kept), [
    'test.color@2.json is missing: every version of "test.color" keeps examples of its parameters (run node scripts/generate-action-versions.mjs)',
  ]);
  assert.deepEqual(versionProblems([v2], [...kept, keptFile(v2)]), []);
  // An upgrader that does not reach valid parameters fails on the old examples.
  const wrong = defineAction({ ...V2, upgrade: { 1: params => params } });
  assert.match(versionProblems([wrong], [...kept, keptFile(v2)])[0], /^test\.color@1\.json: example 0 upgraded to version 2 is not valid now: /);
  // Files of an action that is gone, or of a version ahead of it, are named.
  assert.deepEqual(versionProblems([v1], [...kept, keptFile(v2)]), ['test.color@2.json is newer than "test.color" (version 1)']);
  assert.match(versionProblems([], kept)[0], /names an action whose steps the catalogue does not record/);
});

test('an optional parameter renamed without its upgrader fails on the kept examples, which use every property and branch', () => {
  const OPTIONAL = Object.freeze({
    ...BASE,
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: {
        field: { type: 'string', minLength: 1 },
        scale: { oneOf: [{ type: 'string', enum: ['log', 'linear'] }, { type: 'number', minimum: 0 }] },
      },
    },
  });
  const v1 = defineAction(OPTIONAL);
  assert.deepEqual(examplesOf(v1.params), [{ field: 'x', scale: 'log' }, { field: 'x', scale: 0 }], 'every property, one example per branch');
  // Version 2 renames `scale` to `transform`, and the upgrader forgets it.
  const renamed = { ...OPTIONAL.params, properties: { field: OPTIONAL.params.properties.field, transform: OPTIONAL.params.properties.scale } };
  const forgetful = defineAction({ ...OPTIONAL, params: renamed, version: 2, upgrade: { 1: params => params } });
  const kept = [keptFile(v1), keptFile(forgetful)];
  assert.deepEqual(versionProblems([forgetful], kept).map(problem => problem.replace(/: test\.color.*$/, '')), [
    'test.color@1.json: example 0 upgraded to version 2 is not valid now',
    'test.color@1.json: example 1 upgraded to version 2 is not valid now',
  ]);
  const careful = defineAction({
    ...OPTIONAL, params: renamed, version: 2,
    upgrade: { 1: ({ scale, ...rest }) => (scale === undefined ? rest : { ...rest, transform: scale }) },
  });
  assert.deepEqual(versionProblems([careful], [keptFile(v1), keptFile(careful)]), []);
});

test('defineAction: version and upgrade, checked; upgradeParams runs the upgraders in order', () => {
  assert.equal(defineAction(BASE).version, 1);
  assert.deepEqual(defineAction(BASE).upgrade, {});
  const read = { ...BASE, type: 'test.read', touches: [], effect: 'read', result: { type: 'object', additionalProperties: false, properties: {} } };
  assert.equal(defineAction(read).version, null, 'a read records no step: no version');
  assert.throws(() => defineAction({ ...read, version: 1 }), { message: 'Action "test.read" records no step, so its parameters have no version (version, upgrade)' });
  assert.throws(() => upgradeParams(defineAction(read), 1, {}), { message: '"test.read" records no step, so its parameters have no version' });
  assert.throws(() => defineAction({ ...BASE, version: 0 }), { message: 'Action "test.color" version must be a whole number from 1' });
  assert.throws(() => defineAction({ ...BASE, version: 2 }), {
    message: 'Action "test.color" is at version 2, so upgrade must hold exactly one function for each of versions 1',
  });
  assert.throws(() => defineAction({ ...BASE, upgrade: { 1: params => params } }), {
    message: 'Action "test.color" is at version 1, so upgrade must hold exactly one function for each of no earlier version',
  });
  assert.throws(() => defineAction({ ...V2, upgrade: { 1: 'x' } }), { message: 'Action "test.color" upgrade from version 1 must be a function' });
  const three = defineAction({
    ...V2, version: 3,
    upgrade: { ...V2.upgrade, 2: params => ({ field: { ...params.field, key: params.field.key.toUpperCase() } }) },
  });
  const recorded = { field: 'cd3e' };
  assert.deepEqual(upgradeParams(three, 1, recorded), { field: { source: 'obs', key: 'CD3E' } });
  assert.deepEqual(recorded, { field: 'cd3e' }, 'the recorded parameters are never changed (upgraded on a copy)');
  const mutating = defineAction({ ...V2, upgrade: { 1: params => { params.field = { source: 'obs', key: params.field }; return params; } } });
  const kept = { field: 'x' };
  upgradeParams(mutating, 1, kept);
  assert.deepEqual(kept, { field: 'x' }, 'even by an upgrader that writes in place');
  assert.deepEqual(upgradeParams(three, 3, { field: { source: 'var', key: 'X' } }), { field: { source: 'var', key: 'X' } });
  assert.throws(() => upgradeParams(three, 4, {}), { message: '"test.color" was recorded with version 4 of its parameters, newer than this catalogue\'s 3' });
  assert.throws(() => upgradeParams(three, 0, {}), { message: 'An action version is a whole number from 1, not 0' });
  assert.equal(catalogDocument(createActionCatalog([three])).actions[0].version, 3, 'the catalogue (and its Python and R mirrors) carry the version');
});
