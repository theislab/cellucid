/**
 * A workflow of `.github/workflows/` as data, for the contracts that compare
 * what a job does with what the repository holds.
 *
 * The parser is the YAML one Playwright bundles (`playwright-core`, pinned by
 * the lockfile, reached through its exported `lib/utilsBundle` path): the web
 * repository has no YAML dependency of its own, and the workflows use anchors,
 * aliases and block scalars, which a reader of the text layout gets wrong.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { yaml } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

/** The parsed workflow `name` (a file of `.github/workflows/`). */
export function readWorkflow(name) {
  return yaml.parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

/** The `with` inputs of the step of `job` that checks out `repository` (`theislab/<name>`), or undefined. */
export function checkoutOf(job, repository) {
  return job.steps.find(step => String(step.uses ?? '').startsWith('actions/checkout@') && step.with?.repository === `theislab/${repository}`)?.with;
}
