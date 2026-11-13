/**
 * The static type check of the web app's JavaScript (`npm run check`).
 *
 * The TypeScript compiler reads `assets/js` in place, as JavaScript with
 * JSDoc (`tsconfig.json`: `checkJs`, not strict). Nothing is emitted. A
 * diagnostic fails the check when
 *
 * - it is a syntax error, or
 * - its code is in `DEFECT_FAMILIES`: a diagnostic that means a defect, or a
 *   JSDoc that says something untrue, whatever the typing style of the file, or
 * - its file is in a folder of `FULLY_CHECKED`, where every diagnostic fails.
 *
 * Every other diagnostic is typing style in a folder that is not yet fully
 * checked: counted in the last line, and not a failure. There is no baseline
 * and no directive comment (`tests/type-check-contract.test.mjs` refuses
 * `@ts-ignore` and its kin): a reported line is fixed where it is wrong, in the
 * code or in the JSDoc.
 *
 * Usage:
 *   node scripts/check-types.mjs                  what fails, and one line
 *   node scripts/check-types.mjs --all            every diagnostic too
 *   node scripts/check-types.mjs --folder <path>  every diagnostic of one folder
 *                                                 under assets/js, counted by code
 *
 * Neither option changes what fails. The compiler's API is used, not `tsc`,
 * which can only print everything and fail on anything.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const posix = file => file.split(path.sep).join('/');

const REPOSITORY_ROOT = posix(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE_FOLDER = 'assets/js';
// Vendored code is read by the compiler (fflate is imported) and not checked.
const VENDORED_FOLDER = 'assets/external';

/**
 * The codes that fail the check wherever they occur. This list only grows.
 * Each family: its codes, and the sentence printed under a diagnostic of it.
 */
const DEFECT_FAMILIES = [
  {
    codes: [2304, 2552, 2580, 2581, 2582, 2583, 2584, 2585, 2591, 2592, 2593, 18004, 2448, 2449, 2550],
    advice: 'A name that is not defined here: a missing import, a misspelling, a use before the declaration, '
      + 'a member only a newer engine has, or (in JSDoc) a type to import with import(\'...\').T.',
  },
  {
    codes: [2305, 2724, 2307, 2306, 2459, 2694, 1192, 2613, 2614, 2440, 2528, 2323, 2484],
    advice: 'An import or an export that does not hold: the module does not export that name '
      + '(it moved or was renamed), or exports it twice.',
  },
  {
    codes: [2554, 2555],
    advice: 'A call with the wrong number of arguments. If the call is right, the callee\'s JSDoc signature '
      + 'is not: add the parameter there.',
  },
  {
    codes: [2349, 2348, 2351, 2721, 2722, 2723],
    advice: 'A call or a `new` of something that cannot be called that way. If the code is right, say what '
      + 'the value is: a JSDoc type where it is made, `@type {const}` on a list of pairs.',
  },
  {
    codes: [2451, 2300, 2393, 1117],
    advice: 'The same name declared twice: a variable, a parameter, a method of a class or a property of '
      + 'an object literal.',
  },
  {
    codes: [2588, 2632, 2540, 2630, 2629],
    advice: 'An assignment to something that cannot be assigned: a constant, an import, a function, a class '
      + 'or a getter with no setter.',
  },
  {
    codes: [2367, 2845, 2839, 2869, 2870, 2871, 2872, 2873, 2881],
    advice: 'A comparison or a condition with one possible outcome. If the code is right, a JSDoc type '
      + 'near it is too narrow: type a value checked at run time by what may arrive.',
  },
  {
    codes: [17009, 2377, 2335, 2337, 2341, 2673, 2674, 2445, 2446],
    advice: 'A class rule broken: `this` before `super()`, no `super()`, or a member tagged `@private` or '
      + '`@protected` reached from outside. A member another class or method group reaches does not carry '
      + '`@private`.',
  },
  {
    codes: [8024, 8032, 1016, 1064, 2456, 2577],
    advice: 'A JSDoc that does not match its function or defines a type by itself: a `@param` of no '
      + 'parameter, a required parameter after an optional one, an `async` function whose `@returns` is '
      + 'not a Promise.',
  },
  {
    codes: [7027, 7028],
    advice: 'Unreachable code or an unused label: remove it.',
  },
  {
    codes: [6133, 6192, 6196, 6198, 6199],
    advice: 'A name that is declared and never used: remove the import, the variable or the function.',
  },
];

const DEFECT_ADVICE = new Map(DEFECT_FAMILIES.flatMap(family => family.codes.map(code => [code, family.advice])));

/**
 * Folders in which every diagnostic fails the check. New code starts in one;
 * an existing folder joins when it is clean (`--folder <path>` lists what is
 * left). Paths under `assets/js`, each covering its subtree.
 */
export const FULLY_CHECKED = Object.freeze([
  'app/actions/definitions',
  'app/agent/connect',
  'app/agent/providers',
  'app/dataset',
  'app/jobs',
  'app/notification-center',
  'app/registries/user-defined-fields',
  'app/session/codecs',
  'app/state/actions',
  'app/state/core',
  'app/ui/category-builder',
  'data/anndata/reader',
  'formats/zarr/codecs/javascript',
  'formats/zip',
  'rendering/overlays/shared',
  'rendering/shaders',
  'workers',
]);

const SYNTAX_ADVICE = 'A syntax error: the file does not parse as JavaScript.';

const underFolder = (file, folder) => file.startsWith(`${folder}/`);

function compilerOptionsOf(repositoryRoot) {
  const configPath = `${repositoryRoot}/tsconfig.json`;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repositoryRoot);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return parsed;
}

/**
 * Type-check a set of files with the repository's compiler options.
 *
 * @param {object} [request]
 * @param {string[]|null} [request.files] - Root files, absolute; the files `tsconfig.json` includes when null.
 * @param {string} [request.sourceFolder] - The folder, from the repository's root, the fully checked folders are under.
 * @param {readonly string[]} [request.fullyChecked] - Folders under `sourceFolder` where every diagnostic fails.
 * @param {string|null} [request.buildInfoFile] - Where the compiler keeps what it learnt, for a faster next run.
 * @returns {{failures: object[], others: object[], fileCount: number, folderCount: number, seconds: number}}
 *   Each diagnostic: `{file, line, column, code, message, sourceLine, reason, fails}`.
 */
export function checkTypes({
  files = null,
  sourceFolder = SOURCE_FOLDER,
  fullyChecked = FULLY_CHECKED,
  buildInfoFile = null,
} = {}) {
  const started = performance.now();
  const parsed = compilerOptionsOf(REPOSITORY_ROOT);
  const rootNames = files ?? parsed.fileNames;
  if (rootNames.length === 0) throw new Error('The type check has no file to check: tsconfig.json includes none.');

  const options = buildInfoFile
    ? { ...parsed.options, incremental: true, tsBuildInfoFile: buildInfoFile }
    : parsed.options;
  const program = buildInfoFile
    ? ts.createIncrementalProgram({ rootNames, options })
    : ts.createProgram({ rootNames, options });

  const relative = file => (underFolder(file, REPOSITORY_ROOT) ? file.slice(REPOSITORY_ROOT.length + 1) : null);
  const checkedFiles = program.getSourceFiles()
    .map(source => relative(posix(source.fileName)))
    .filter(file => file && underFolder(file, sourceFolder) && file.endsWith('.js'));

  // A folder that names no file would be a check that checks nothing.
  for (const folder of fullyChecked) {
    if (!checkedFiles.some(file => underFolder(file, `${sourceFolder}/${folder}`))) {
      throw new Error(`FULLY_CHECKED names ${sourceFolder}/${folder}, which holds no checked .js file.`);
    }
  }
  const fullFolderOf = file => fullyChecked.find(folder => underFolder(file, `${sourceFolder}/${folder}`)) ?? null;

  const global = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (global.length > 0) {
    throw new Error(global.map(each => ts.flattenDiagnosticMessageText(each.messageText, '\n')).join('\n'));
  }

  const failures = [];
  const others = [];
  const collect = (diagnostics, syntactic) => {
    for (const diagnostic of diagnostics) {
      const file = diagnostic.file ? relative(posix(diagnostic.file.fileName)) : null;
      if (!file || underFolder(file, VENDORED_FOLDER)) continue;
      const start = diagnostic.start ?? 0;
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(start);
      const fullFolder = fullFolderOf(file);
      const reason = syntactic
        ? SYNTAX_ADVICE
        : DEFECT_ADVICE.get(diagnostic.code)
          ?? (fullFolder
            ? `${fullFolder} is fully checked (scripts/check-types.mjs, FULLY_CHECKED): every diagnostic fails here.`
            : null);
      const entry = {
        file,
        line: line + 1,
        column: character + 1,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        sourceLine: diagnostic.file.text.split(/\r?\n/)[line] ?? '',
        reason,
        fails: reason !== null,
      };
      (entry.fails ? failures : others).push(entry);
    }
  };
  collect(program.getSyntacticDiagnostics(), true);
  collect(program.getSemanticDiagnostics(), false);
  if (buildInfoFile) program.emit();

  return {
    failures,
    others,
    fileCount: checkedFiles.length,
    folderCount: fullyChecked.length,
    seconds: (performance.now() - started) / 1000,
  };
}

function printed(entry) {
  const gutter = String(entry.line);
  const lines = [
    `${entry.file}:${entry.line}:${entry.column}  TS${entry.code}  ${entry.message.split('\n').join('\n    ')}`,
    `    ${gutter} | ${entry.sourceLine.replaceAll('\t', ' ')}`,
    `    ${' '.repeat(gutter.length)} | ${' '.repeat(entry.column - 1)}^`,
  ];
  if (entry.reason) lines.push(`    ${entry.reason}`);
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const all = argv.includes('--all');
  const folderAt = argv.indexOf('--folder');
  const folder = folderAt >= 0 ? argv[folderAt + 1]?.replace(/\/+$/, '') : null;
  if (folderAt >= 0 && !folder) throw new Error('--folder takes a path under assets/js.');
  const unknown = argv.filter((arg, index) => arg !== '--all' && arg !== '--folder' && index !== folderAt + 1);
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(' ')}`);

  // One build-information file a checkout: worktrees of the repository may
  // share one node_modules, and a file another checkout wrote would make every
  // run a full one, or be read while it is being written.
  const cacheFolder = `${REPOSITORY_ROOT}/node_modules/.cache/cellucid-type-check`;
  fs.mkdirSync(cacheFolder, { recursive: true });
  const checkout = createHash('sha256').update(fs.realpathSync(REPOSITORY_ROOT)).digest('hex').slice(0, 16);
  const result = checkTypes({ buildInfoFile: `${cacheFolder}/tsbuildinfo-${checkout}` });

  for (const entry of result.failures) console.log(printed(entry));
  if (all) for (const entry of result.others) console.log(printed(entry));
  if (folder) {
    const inFolder = [...result.failures, ...result.others]
      .filter(entry => underFolder(entry.file, `${SOURCE_FOLDER}/${folder}`));
    const byCode = new Map();
    for (const entry of inFolder) {
      if (!entry.fails && !all) console.log(printed(entry));
      byCode.set(entry.code, (byCode.get(entry.code) ?? 0) + 1);
    }
    const counts = [...byCode].sort((a, b) => b[1] - a[1]).map(([code, count]) => `TS${code} ${count}`).join(', ');
    console.log(`${SOURCE_FOLDER}/${folder}: ${inFolder.length} diagnostics${counts ? ` (${counts})` : ''}.`);
  }

  const time = `${result.seconds.toFixed(1)} s`;
  if (result.failures.length > 0) {
    console.log(`Type check: ${result.failures.length} to fix in ${result.fileCount} files (${time}). `
      + `${result.others.length} other diagnostics are typing style in folders not yet fully checked; `
      + 'they do not fail the check.');
    process.exitCode = 1;
  } else {
    console.log(`Type check: clean. ${result.fileCount} files, ${result.folderCount} folders fully checked (${time}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
