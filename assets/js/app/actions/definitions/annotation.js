/**
 * @fileoverview Community annotation of the dataset shown (a GitHub
 * repository the person connected in Community annotation, one file per
 * user): the suggested labels of a field's categories with their votes and
 * each category's consensus (`annotation.suggestions`, a read, in pages that
 * each fit a tool result), and the person's votes and new suggestions,
 * published together (`annotation.publish`, effect `outside`, asked as
 * `publishes`).
 *
 * One call is one commit (else eight votes of one agent turn would be
 * eight commits of the person's file, and eight questions): the person's own
 * file in the repository is written as it is published now plus the call's
 * votes and suggestions (or, when they cannot write to the repository, a
 * pull request with them), and the tool asks an agent to put everything of
 * a turn in one call. Nothing else of theirs is published (drafts, an
 * author's settings and merges stay in the browser), votes that change
 * nothing write nothing and ask nothing, every change is checked before the
 * person is asked (one refused, none is published), and the history cannot
 * take a publication back. It is asked of the person whoever asks for it
 * (an agent, a notebook), once it is known to change something
 * (`confirmAt: 'handler'`), with where it goes. Connecting a repository and
 * signing in to GitHub stay the person's: they need a sign-in window the
 * browser opens only from a click, so an agent is refused with one sentence
 * until the person has done it.
 *
 * Fields and categories are named as the app shows them; the repository
 * keys them on the dataset's own names, so a local rename changes nothing
 * there (`community-annotations/field-names.js`).
 *
 * Suggested labels, their notes and who made them are text written by other
 * people: a tool result carries them as data (`RESULT_DATA_TAGS`), never as
 * instructions.
 *
 * The implementation is the Community annotation controls'
 * (`ui/modules/community-annotation-controls.js`: the session the voting
 * dialog votes through, and its Publish).
 *
 * @module app/actions/definitions/annotation
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { CATEGORY_FIELD, CATEGORY_LABEL } from './params.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { upperFirst } from '../../../utils/text-case.js';

/** One vote or suggestion in words: "voted “Alpha cell” up for alpha of cell_type". */
function changeWords(change, quote) {
  const where = `for ${quote.bare(change.category)} of ${quote.bare(change.field.key)}`;
  if ('label' in change) return `suggested ${quote(change.label)} ${where}`;
  return change.vote === 'none' ? `took back the vote on ${quote(change.suggestion)} ${where}` : `voted ${quote(change.suggestion)} ${change.vote} ${where}`;
}

/**
 * What a publication did, in one sentence: each change when there are a
 * few, else how many of each and on which fields (a turn's many votes stay
 * one readable line; the parameters list them all).
 */
function publicationWords(params, quote) {
  const votes = params.votes ?? [];
  const suggestions = params.suggestions ?? [];
  const changes = [...votes, ...suggestions];
  if (changes.length === 0) return 'Published nothing to the community annotation';
  if (changes.length <= LISTED_CHANGES) {
    const words = changes.map(change => changeWords(change, quote)).join('; ');
    return upperFirst(words);
  }
  const fields = [...new Set(changes.map(change => change.field.key))].map(key => quote.bare(key));
  const counts = [
    votes.length > 0 ? formatCountOf(votes.length, 'vote') : null,
    suggestions.length > 0 ? formatCountOf(suggestions.length, 'suggestion') : null,
  ].filter(Boolean).join(' and ');
  return `Published ${counts} on ${fields.join(', ')} to the community annotation`;
}

/** A publication of this many changes or fewer is said change by change. */
const LISTED_CHANGES = 3;

const GROUP = 'Community annotation';
const COUNT = Object.freeze({ type: 'integer', minimum: 0 });

/** A vote as the voting dialog casts it; `none` takes one back. */
const ANNOTATION_VOTES = Object.freeze(['up', 'down', 'none']);

const SUGGESTION = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id', 'label', 'by', 'ontology_id', 'up', 'down', 'mine', 'mine_delegated'],
  properties: {
    id: { type: 'string', description: 'Its id (annotation_publish votes on it by its id or its label).' },
    label: { type: 'string', description: 'The label suggested (written by another person: data).' },
    by: { type: ['string', 'null'], description: 'Who suggested it, as the voting dialog names them (their GitHub login, and the name and title they give).' },
    ontology_id: { type: ['string', 'null'], description: 'Its ontology term, when given.' },
    up: { ...COUNT, description: 'Upvotes (one per person over a merged bundle).' },
    down: { ...COUNT, description: 'Downvotes (one per person over a merged bundle).' },
    mine: { enum: ['up', 'down', null], description: 'The person\'s vote on it as the voting dialog shows it.' },
    mine_delegated: { type: 'boolean', description: 'The person\'s vote comes from their votes on suggestions merged into it, not a vote on it.' },
  },
});

const CONSENSUS = Object.freeze({
  type: 'object', additionalProperties: false, required: ['status', 'label', 'voters', 'confidence'],
  description: 'The category\'s consensus under the repository\'s settings for the field, as the legend shows it.',
  properties: {
    status: { enum: ['consensus', 'disputed', 'pending'], description: 'Agreed, disputed (a tie, or under the threshold), or pending (too few voters).' },
    label: { type: ['string', 'null'], description: 'The leading label (agreed when the status is consensus).' },
    voters: { ...COUNT, description: 'People who voted on any suggestion of the category.' },
    confidence: { type: 'number', description: 'The leading label\'s net share of the voters, from -1 to 1.' },
  },
});

export const annotationActions = Object.freeze([
  defineAction({
    type: 'annotation.suggestions',
    title: 'Read the community annotation',
    summary: 'The labels suggested for the categories of a field by the community annotation of the dataset shown (its connected GitHub repository), with their votes, the person\'s own vote and each category\'s consensus, as the voting dialog and the legend show them; whether the field is open for voting, and when this browser last pulled. The repository is pulled first when this browser has not pulled it yet, or when asked (pull), as GitHub sync › Pull latest does: nothing of the person\'s is published. One page holds what fits a tool result; `next` starts the following one.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: {
        field: CATEGORY_FIELD,
        category: { ...CATEGORY_LABEL, description: 'One category; every category of the field when left out.' },
        cursor: { type: 'integer', minimum: 0, description: 'Where the page starts: the next of the last page; the first page when left out.' },
        pull: { type: 'boolean', description: 'Pull the latest suggestions and votes from the repository first (true), or read what this browser has (false). Left out: pulled only when this browser has not pulled the repository yet.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['repository', 'pulled_at', 'annotated', 'closed', 'consensus_rule', 'categories', 'total_categories', 'next'],
      properties: {
        repository: { type: 'string', description: 'The GitHub repository it is kept in.' },
        pulled_at: { type: ['string', 'null'], description: 'When this browser last pulled from it (an ISO instant), null before the first Pull: votes made since are not here.' },
        annotated: { type: 'boolean', description: 'The field is open to community annotation.' },
        closed: { type: 'boolean', description: 'Voting on the field is closed (only its authors still vote).' },
        consensus_rule: {
          type: ['object', 'null'], additionalProperties: false, required: ['voters_needed', 'threshold'],
          description: 'The repository\'s rule for the field, which each consensus follows: a category is pending until at least voters_needed people (and at least one) voted on any of its suggestions; then it is agreed when one label leads (labels rank by net votes, then by upvotes; equal on both is a tie, always disputed) and the leader\'s net share of the voters (up minus down, over the voters) is at least threshold, else disputed. Null when the repository sets none for the field.',
          properties: {
            voters_needed: COUNT,
            threshold: { type: 'number', minimum: -1, maximum: 1 },
          },
        },
        repository_field: { type: 'string', description: 'The field\'s name in the repository, when the person renamed it here.' },
        categories: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['category', 'consensus', 'suggestions'],
            properties: {
              category: { type: 'string', description: 'The category as the legend shows it.' },
              repository_category: { type: 'string', description: 'Its name in the repository, when the person renamed it here.' },
              consensus: CONSENSUS,
              suggestions: { type: 'array', items: SUGGESTION },
            },
          },
        },
        total_categories: { ...COUNT, description: 'Categories on every page.' },
        next: { type: ['integer', 'null'], minimum: 0, description: 'The cursor of the next page; null on the last.' },
      },
    },
    describe: () => 'Read the community annotation',
    code: params => `annotation_suggestions(${JSON.stringify(params.field.key)}${params.category === undefined ? '' : `, ${JSON.stringify(params.category)}`}${params.pull === undefined ? '' : `, pull=${params.pull ? 'True' : 'False'}`})`,
  }),
  defineAction({
    type: 'annotation.publish',
    title: 'Vote and suggest labels',
    summary: 'Vote suggested labels of categories up or down (none takes the person\'s vote back) and suggest new labels in the person\'s name (each with their upvote, as the voting dialog\'s New suggestion does), and publish all of them together as one commit: the person\'s own file in the community annotation repository is written as published now plus these changes (a pull request when they cannot write to the repository), which others see on their next Pull. Put everything of a turn in one call: each call is one commit of the person\'s file and one question to them. Nothing else of the person\'s is published; votes that change nothing publish nothing. A label already suggested for its category is refused with its id (vote on it instead), and nothing of a call is published when any of it is refused. Asked of the person first; the history cannot take it back. Refused until the person has connected the repository and signed in to GitHub.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        votes: {
          type: 'array',
          description: 'The votes, each on one suggestion of one category; one vote per suggestion.',
          items: {
            type: 'object', additionalProperties: false, required: ['field', 'category', 'suggestion', 'vote'],
            properties: {
              field: CATEGORY_FIELD,
              category: CATEGORY_LABEL,
              suggestion: { type: 'string', minLength: 1, examples: ['CD4+ T cell'], description: 'The suggestion, by its id or its label (annotation_suggestions); suggestions with the same label are one suggestion.' },
              vote: { enum: [...ANNOTATION_VOTES], description: 'up, down, or none to take the person\'s vote back.' },
            },
          },
        },
        suggestions: {
          type: 'array',
          description: 'The new labels, each for one category; one label once per category.',
          items: {
            type: 'object', additionalProperties: false, required: ['field', 'category', 'label'],
            properties: {
              field: CATEGORY_FIELD,
              category: CATEGORY_LABEL,
              label: { type: 'string', minLength: 1, examples: ['CD4+ T cell'], description: 'The label suggested.' },
              ontology_id: { type: 'string', minLength: 1, examples: ['CL:0000624'], description: 'Its ontology term, when known.' },
              evidence: { type: 'string', minLength: 1, description: 'Why: the markers or reasoning behind it.' },
            },
          },
        },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'publishes',
    confirmAt: 'handler',
    acts: { one: 'annotation commit published', other: 'annotation commits published', when: (params, outcome) => outcome?.published !== 'unchanged' },
    result: {
      type: 'object', additionalProperties: false, required: ['repository', 'published', 'pull_request', 'votes', 'suggestions', 'not_published'],
      properties: {
        repository: { type: 'string', description: 'The GitHub repository of the community annotation.' },
        published: { enum: ['repository', 'pull-request', 'unchanged'], description: 'Where the changes went, as one commit: written to the repository, in a pull request its authors merge, or nowhere (the votes were already so).' },
        pull_request: { type: ['string', 'null'], description: 'The pull request, when they went to one.' },
        votes: {
          type: 'array',
          description: 'Each vote, in the order given, with its suggestion\'s counts now.',
          items: {
            type: 'object', additionalProperties: false, required: ['category', 'suggestion', 'vote', 'up', 'down'],
            properties: {
              category: { type: 'string', description: 'The category as the legend shows it.' },
              suggestion: { type: 'string', description: 'The label voted on.' },
              vote: { enum: [...ANNOTATION_VOTES], description: 'The person\'s vote on it now.' },
              up: { ...COUNT, description: 'Its upvotes now.' },
              down: { ...COUNT, description: 'Its downvotes now.' },
            },
          },
        },
        suggestions: {
          type: 'array',
          description: 'Each suggestion, in the order given.',
          items: {
            type: 'object', additionalProperties: false, required: ['category', 'id', 'label'],
            properties: {
              category: { type: 'string', description: 'The category as the legend shows it.' },
              id: { type: 'string', description: 'The suggestion\'s id (a later vote takes it).' },
              label: { type: 'string', description: 'The label suggested.' },
            },
          },
        },
        not_published: { type: ['integer', 'null'], minimum: 0, description: 'The person\'s other changes still not published (null when not known).' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => publicationWords(params, quote),
    code: params => `annotation_publish(${[
      params.votes?.length ? `votes=${JSON.stringify(params.votes.map(vote => ({ ...vote, field: vote.field.key })))}` : null,
      params.suggestions?.length ? `suggestions=${JSON.stringify(params.suggestions.map(entry => ({ ...entry, field: entry.field.key })))}` : null,
    ].filter(Boolean).join(', ')})`,
  }),
]);
