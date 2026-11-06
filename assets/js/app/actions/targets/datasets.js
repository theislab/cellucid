/**
 * @fileoverview Which dataset a name the person gave means: a built-in
 * sample, one of their datasets (My datasets), or a link (`dataset.open`).
 *
 * A name matches a sample by its id or its name, and a dataset of My
 * datasets by its name, ignoring case, spacing and punctuation ("pancreas",
 * "Pancreatic endocrinogenesis (scVelo)"); failing that, one dataset whose
 * name holds every word of it ("lung" for "Developing human lung (He)").
 * Several matches, or none, are refused with one sentence that lists what
 * there is, so the agent asks the person or picks from the list. A sample
 * that is also listed in My datasets (opened before) is one dataset, not
 * two. A web address, and what matches nothing, is tried as a link when the
 * link box would take it (`linkProblem`).
 *
 * `resolveMyDataset` resolves a name among My datasets alone, for an action
 * on that list (`my-datasets.forget`).
 *
 * Pure: the samples, My datasets and the link check are handed in.
 *
 * @module app/actions/targets/datasets
 */

import { ActionRefused } from '../dispatcher.js';
import { listNames, quoteName } from './names.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** A name as it is compared: lower case, words of letters and digits, single spaces. */
export function comparableName(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function wordsOf(text) {
  return comparableName(text).split(' ').filter(word => word.length > 0);
}

/**
 * The candidates whose names match `name`: exactly (any of `namesOf`), else
 * those whose name holds every word of it.
 *
 * @template T
 * @param {string} name
 * @param {readonly T[]} candidates
 * @param {(candidate: T) => string[]} namesOf
 * @returns {{exact: T[], partial: T[]}}
 */
export function matchByName(name, candidates, namesOf) {
  const wanted = comparableName(name);
  const words = wordsOf(name);
  const exact = [];
  const partial = [];
  if (wanted.length === 0) return { exact, partial };
  for (const candidate of candidates) {
    const names = namesOf(candidate).filter(Boolean);
    if (names.some(each => comparableName(each) === wanted)) {
      exact.push(candidate);
    } else if (names.some(each => {
      const have = new Set(wordsOf(each));
      return words.every(word => have.has(word));
    })) {
      partial.push(candidate);
    }
  }
  return { exact, partial };
}

const sampleNames = sample => [sample.id, sample.name];
const myNames = entry => [entry.name];

/** Whether a My datasets entry is this sample (a sample the person opened is listed there too). */
function isSampleEntry(entry, sample) {
  return entry.source?.kind === 'sample' && entry.source.dataset === sample.id;
}

function refuse(message, type = 'dataset.open') {
  return new ActionRefused(message, { code: 'unknown-dataset', type });
}

function samplesSentence(samples) {
  return samples.length === 0 ? 'this page lists no samples' : `the samples are ${listNames(samples.map(sample => sample.name))}`;
}

function mineSentence(mine) {
  return mine.length === 0
    ? 'My datasets is empty in this browser'
    : `the person's datasets (My datasets) are ${listNames(mine.map(entry => entry.name))}`;
}

/**
 * What `name` opens.
 *
 * @param {string} name
 * @param {{
 *   kind: 'any'|'sample'|'my-datasets'|'link',
 *   samples: ReadonlyArray<{id: string, name: string}>,
 *   mine: ReadonlyArray<{id: string, name: string, source: {kind: string, dataset?: string}}>,
 *   linkProblem: (text: string) => string|null,
 * }} where - `linkProblem`: why the link box would not take `text`, or null
 * @returns {{kind: 'sample', sample: object} | {kind: 'my-datasets', entry: object} | {kind: 'link', value: string}}
 */
export function resolveDatasetName(name, { kind, samples, mine, linkProblem }) {
  const text = String(name).trim();
  // A web address is a link whatever the names around it are.
  if (kind === 'link' || (kind === 'any' && /^[a-z][a-z0-9+.-]*:\/\//i.test(text))) {
    const problem = linkProblem(text);
    if (problem !== null) throw refuse(problem);
    return { kind: 'link', value: text };
  }
  const sampleMatch = kind === 'my-datasets' ? { exact: [], partial: [] } : matchByName(text, samples, sampleNames);
  // A sample listed in My datasets is the sample.
  const sampleIds = new Set([...sampleMatch.exact, ...sampleMatch.partial].map(sample => sample.id));
  const mineMatch = kind === 'sample'
    ? { exact: [], partial: [] }
    : matchByName(text, mine.filter(entry => kind === 'my-datasets' || !(entry.source?.kind === 'sample' && sampleIds.has(entry.source.dataset))), myNames);

  const pick = (sampleList, mineList) => {
    const found = [
      ...sampleList.map(sample => ({ kind: 'sample', sample, name: sample.name })),
      ...mineList.map(entry => ({ kind: 'my-datasets', entry, name: entry.name })),
    ];
    if (found.length === 1) {
      const [only] = found;
      return only.kind === 'sample' ? { kind: 'sample', sample: only.sample } : { kind: 'my-datasets', entry: only.entry };
    }
    if (found.length > 1) {
      const both = sampleList.length > 0 && mineList.length > 0;
      throw refuse(`${quoteName(text)} names ${formatCountOf(found.length, 'dataset')}: ${listNames(found.map(each => each.name))}. `
        + (both ? 'Name one exactly, or say kind "sample" or "my-datasets".' : 'Name one exactly.'));
    }
    return null;
  };
  const exact = pick(sampleMatch.exact, mineMatch.exact);
  if (exact !== null) return exact;
  const partial = pick(sampleMatch.partial, mineMatch.partial);
  if (partial !== null) return partial;

  if (kind === 'sample') throw refuse(`There is no sample ${quoteName(text)}: ${samplesSentence(samples)}.`);
  if (kind === 'my-datasets') throw refuse(`No dataset in My datasets is called ${quoteName(text)}: ${mineSentence(mine)}.`);
  if (linkProblem(text) === null) return { kind: 'link', value: text };
  const listedMine = mine.filter(entry => !samples.some(sample => isSampleEntry(entry, sample)));
  throw refuse(`There is no dataset ${quoteName(text)}: ${samplesSentence(samples)}; ${mineSentence(listedMine)}; `
    + 'or give a link to a dataset or an accession (GSE123456, a DOI, a CELLxGENE address).');
}

/**
 * The dataset of My datasets that `name` means (exactly, else the one whose
 * name holds every word of it), for an action on the list itself
 * (`my-datasets.forget`). Several matches, or none, are refused with one
 * sentence that lists the names there are.
 *
 * @template {{name: string}} T
 * @param {string} name
 * @param {readonly T[]} mine
 * @param {string} type - the action refused
 * @returns {T}
 */
export function resolveMyDataset(name, mine, type) {
  const text = String(name).trim();
  const { exact, partial } = matchByName(text, mine, myNames);
  for (const found of [exact, partial]) {
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw refuse(`${quoteName(text)} names ${formatCountOf(found.length, 'dataset')} of My datasets: ${listNames(found.map(entry => entry.name))}. Name one exactly.`, type);
    }
  }
  throw refuse(`No dataset in My datasets is called ${quoteName(text)}: ${mineSentence(mine)}.`, type);
}
