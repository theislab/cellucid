#!/usr/bin/env node
/**
 * Keep examples of every version of the parameters of every action whose
 * steps are recorded (effect `state`, `view` or `layout`; a read or a move of
 * the history records no step, so it has no version), so a history recorded
 * with older parameters keeps replaying (History v2 §3.8, owner decision
 * 2026-11-04):
 *
 *   tests/fixtures/action-versions/<type>@<version>.json
 *     {type, version, params: <the shape of that version's params schema>, examples: [<params of that version>, …]}
 *
 * The shape is the schema without its words (`actionParamsShape` in
 * `app/actions/catalog.js`): rewording a description changes no parameter,
 * while a new, renamed or retyped parameter, another enumeration, bound or
 * default does. The examples use every property of the schema, optional ones
 * included, and every branch of every `oneOf` (`examplesOf` in
 * `app/actions/schema.js`), so an upgrader that forgets one fails.
 *
 * A file is written once, for the version an action is at now, and never
 * changed afterwards: it is the record of what that version's parameters
 * were. The drift test (`tests/action-versions-contract.test.mjs`) fails
 *
 * - when an action's params shape differs from its current version's file: a
 *   change of the parameters without a version bump (bump `version` in its
 *   definition, add `upgrade[<old version>]`, and run this script, which
 *   writes the new version's file beside the old one's);
 * - when an example of an earlier version, upgraded step by step
 *   (`upgradeParams`), is not valid for the parameters now (an upgrader the
 *   action declares values-only, `valuesOnlyUpgrade`, refuses instead, and
 *   that is its record);
 * - when a version of an action has no file, or a file names an action, or a
 *   version, the catalogue does not record;
 * - when a file's bytes differ from the digest the test pins (a file deleted
 *   and written again, or edited by hand).
 *
 *   node scripts/generate-action-versions.mjs            # write the missing files, remove those of removed actions
 *   node scripts/generate-action-versions.mjs --check    # exit 1 when a file is missing, stale or orphaned
 *   node scripts/generate-action-versions.mjs --digests  # print the digest list the test pins
 *
 * An action removed from the catalogue (or that no longer records steps)
 * takes its files with it: nothing can replay its steps any more ("Recorded
 * with another version"). The files are canonical JSON (keys sorted,
 * two-space indent, one trailing newline), as the catalogue is.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { actionParamsShape, createActionCatalog, ParamsNotUpgradable, upgradeParams } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { examplesOf, schemaProblem } from '../assets/js/app/actions/schema.js';
import { sortedKeys } from './generate-action-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACTION_VERSIONS_DIR = path.join(ROOT, 'tests', 'fixtures', 'action-versions');

const FILE_PATTERN = /^(.+)@([1-9][0-9]*)\.json$/;

/** The file name of a version of an action. */
export function versionFileName(type, version) {
  return `${type}@${version}.json`;
}

/** Canonical text of a shape (what two versions are compared by). */
function shapeText(schema) {
  return JSON.stringify(sortedKeys(actionParamsShape(schema)));
}

/** The canonical text of the current version's file of a recorded action. */
export function renderVersionExample(definition) {
  const record = {
    type: definition.type, version: definition.version, params: actionParamsShape(definition.params), examples: examplesOf(definition.params),
  };
  return `${JSON.stringify(sortedKeys(record), null, 2)}\n`;
}

/** Every kept file: `{name, type, version, record, text}` (`record` null when it is not JSON). */
export function readVersionFiles(dir = ACTION_VERSIONS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    const match = FILE_PATTERN.exec(name);
    const text = readFileSync(path.join(dir, name), 'utf8');
    let record = null;
    try {
      record = JSON.parse(text);
    } catch {
      record = null;
    }
    return { name, type: match?.[1] ?? null, version: match === null ? null : Number(match[2]), record, text };
  });
}

/** `{<file name>: <SHA-256 of its bytes>}`, sorted: what the drift test pins. */
export function versionFileDigests(files) {
  return Object.fromEntries(files.map(file => [file.name, createHash('sha256').update(file.text).digest('hex')]));
}

/**
 * What is wrong between the definitions and the kept files, one sentence
 * each (empty when they agree).
 *
 * @param {object[]} definitions - `defineAction` results
 * @param {{name: string, type: string|null, version: number|null, record: object|null, text: string}[]} files
 * @returns {string[]}
 */
export function versionProblems(definitions, files) {
  const catalog = createActionCatalog(definitions);
  const recorded = catalog.list().filter(definition => definition.version !== null);
  const problems = [];
  const byName = new Map(files.map(file => [file.name, file]));
  const changed = new Set();
  for (const definition of recorded) {
    for (let version = 1; version <= definition.version; version++) {
      const name = versionFileName(definition.type, version);
      if (!byName.has(name)) problems.push(`${name} is missing: every version of "${definition.type}" keeps examples of its parameters (run node scripts/generate-action-versions.mjs)`);
    }
    const current = byName.get(versionFileName(definition.type, definition.version));
    if (current?.record?.params !== undefined && JSON.stringify(sortedKeys(current.record.params)) !== shapeText(definition.params)) {
      changed.add(current.name);
      problems.push(`The parameters of "${definition.type}" changed at version ${definition.version}: bump its version to ${definition.version + 1}, `
        + `add upgrade[${definition.version}] (parameters of version ${definition.version} to ${definition.version + 1}), `
        + 'and run node scripts/generate-action-versions.mjs to keep examples of the new version');
    }
  }
  for (const file of files) {
    if (file.type === null) { problems.push(`${file.name} is not named <type>@<version>.json`); continue; }
    if (changed.has(file.name)) continue;
    if (!catalog.has(file.type) || catalog.get(file.type).version === null) {
      problems.push(`${file.name} names an action whose steps the catalogue does not record (run node scripts/generate-action-versions.mjs to remove it)`);
      continue;
    }
    const definition = catalog.get(file.type);
    if (file.version > definition.version) { problems.push(`${file.name} is newer than "${file.type}" (version ${definition.version})`); continue; }
    const { record } = file;
    if (record === null || record.type !== file.type || record.version !== file.version || record.params === undefined
      || !Array.isArray(record.examples) || record.examples.length === 0) {
      problems.push(`${file.name} must hold its type, its version, its params shape and its examples`);
      continue;
    }
    record.examples.forEach((example, index) => {
      const own = schemaProblem(record.params, example, `${file.type}@${file.version}`);
      if (own !== null) { problems.push(`${file.name}: example ${index} is not valid for its own shape: ${own}`); return; }
      let upgraded;
      try {
        upgraded = upgradeParams(definition, file.version, example);
      } catch (error) {
        // Declared by the action (`valuesOnlyUpgrade`): its steps are put back by their values.
        if (error instanceof ParamsNotUpgradable) return;
        problems.push(`${file.name}: upgrading example ${index} failed: ${error.message}`);
        return;
      }
      const now = schemaProblem(definition.params, upgraded, file.type);
      if (now !== null) problems.push(`${file.name}: example ${index} upgraded to version ${definition.version} is not valid now: ${now}`);
    });
  }
  return problems;
}

function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.filter(flag => flag !== '--check' && flag !== '--digests');
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}; the arguments are --check and --digests`);
  if (flags.includes('--digests')) {
    for (const [name, digest] of Object.entries(versionFileDigests(readVersionFiles()))) console.log(`  '${name}': '${digest}',`);
    return;
  }
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const recorded = catalog.list().filter(definition => definition.version !== null);
  if (!flags.includes('--check')) {
    mkdirSync(ACTION_VERSIONS_DIR, { recursive: true });
    for (const file of readVersionFiles()) {
      if (file.type !== null && (!catalog.has(file.type) || catalog.get(file.type).version === null)) {
        rmSync(path.join(ACTION_VERSIONS_DIR, file.name));
        console.log(`removed ${file.name} (its action records no step, or is gone)`);
      }
    }
    let written = 0;
    for (const definition of recorded) {
      const target = path.join(ACTION_VERSIONS_DIR, versionFileName(definition.type, definition.version));
      if (existsSync(target)) continue;
      writeFileSync(target, renderVersionExample(definition));
      written += 1;
      console.log(`wrote   ${path.relative(ROOT, target)}`);
    }
    console.log(`${written} written, ${recorded.length} recorded actions`);
  }
  const problems = versionProblems(ACTION_DEFINITIONS, readVersionFiles());
  for (const problem of problems) console.log(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
