#!/usr/bin/env node
/**
 * Check the live Google Analytics property against what the privacy model
 * documents: the tag container Google serves for Cellucid's measurement id
 * holds the property's admin settings, which no file in this repository
 * controls. `app/ui/core/ga-init.js` already denies advertising use of user
 * data and reduces every hit's page location to origin and path; this checks
 * that what the property adds stays within the privacy model. Enhanced
 * measurement (page changes, scrolls, outbound clicks, site search, video,
 * file downloads, form interactions) is on by the owner's choice and is not
 * checked.
 *
 * Fails (exit 1, naming each setting) when the container has
 *
 * - automatic user-provided data collection (the `__ogt_1p_data_v2` tag with
 *   automatic detection of e-mail addresses, phone numbers or addresses);
 * - a query-parameter redaction list that misses a parameter naming what the
 *   page opens (`DATA_PARAMETERS`).
 *
 * Usage: `node scripts/check-analytics-property.mjs [saved-container.js]`
 * (fetches the live container when no file is given). Run it after changing
 * the property's settings, and before a release.
 */

import { readFile } from 'node:fs/promises';

const MEASUREMENT_ID = 'G-K4774ZWGEQ';
const CONTAINER_URL = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;

/** The page parameters that name what the page opens (`app/url-state.js`, `preconnect-init.js`, community annotation). */
const DATA_PARAMETERS = ['data', 'remote', 'dataset', 'samplecatalog', 'annotations', 'source', 'anndata'];

const source = process.argv[2]
  ? await readFile(process.argv[2], 'utf8')
  : await (await fetch(CONTAINER_URL)).text();

const problems = [];
for (const [tag] of source.matchAll(/"function":"__ogt_1p_data_v2"[^}]*\}/g)) {
  if (/"vtp_isEnabled":true/.test(tag) && /"vtp_isAutoEnabled":true/.test(tag)) {
    problems.push('user-provided data collection: automatic detection is on');
  }
}
const redacted = /"vtp_redactQueryParams":"([^"]*)"/.exec(source)?.[1] ?? '';
const listed = new Set(redacted.split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
for (const name of DATA_PARAMETERS) {
  if (!listed.has(name)) problems.push(`redaction: query parameter "${name}" is not redacted`);
}

if (problems.length > 0) {
  console.error(`The Google Analytics property ${MEASUREMENT_ID} collects more than the privacy model says:`);
  for (const problem of [...new Set(problems)]) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`The Google Analytics property ${MEASUREMENT_ID} matches the privacy model.`);
