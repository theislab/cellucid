/**
 * @fileoverview Community annotation of the dataset shown (a GitHub
 * repository the person connected in Community annotation, one file per
 * user): the suggested labels of a field's categories with their votes and
 * each category's consensus (`annotation.suggestions`, a read, in pages that
 * each fit a tool result), a vote on one and a new suggestion, each
 * published alone (`annotation.vote`, `annotation.suggest`, effect
 * `outside`, asked as `publishes`).
 *
 * A vote is the voting dialog's ▲ or ▼, published at once and alone: the
 * person's own file in the repository is written as it is published now
 * plus this one vote (or, when they cannot write to the repository, a pull
 * request with it). Nothing else of theirs is published (drafts, an author's
 * settings and merges stay in the browser), a vote that changes nothing
 * writes nothing and asks nothing, and the history cannot take a published
 * vote back. It is asked of the person whoever asks for it (an agent, a
 * notebook), once the vote is known to change something (`confirmAt:
 * 'handler'`), with where it goes. Connecting a repository and signing in to
 * GitHub stay the person's: they need a sign-in window the browser opens
 * only from a click, so an agent is refused with one sentence until the
 * person has done it.
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

const GROUP = 'Community annotation';
const COUNT = Object.freeze({ type: 'integer', minimum: 0 });

/** A vote as the voting dialog casts it; `none` takes one back. */
export const ANNOTATION_VOTES = Object.freeze(['up', 'down', 'none']);

const SUGGESTION = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id', 'label', 'by', 'ontology_id', 'up', 'down', 'mine', 'mine_delegated'],
  properties: {
    id: { type: 'string', description: 'Its id (annotation_vote takes it, or its label).' },
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
    summary: 'The labels suggested for the categories of a field by the community annotation of the dataset shown (its connected GitHub repository), with their votes, the person\'s own vote and each category\'s consensus, as the voting dialog and the legend show them; whether the field is open for voting, and when this browser last pulled. One page holds what fits a tool result; `next` starts the following one.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: {
        field: CATEGORY_FIELD,
        category: { ...CATEGORY_LABEL, description: 'One category; every category of the field when left out.' },
        cursor: { type: 'integer', minimum: 0, description: 'Where the page starts: the next of the last page; the first page when left out.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['repository', 'pulled_at', 'annotated', 'closed', 'categories', 'total_categories', 'next'],
      properties: {
        repository: { type: 'string', description: 'The GitHub repository it is kept in.' },
        pulled_at: { type: ['string', 'null'], description: 'When this browser last pulled from it (an ISO instant), null before the first Pull: votes made since are not here.' },
        annotated: { type: 'boolean', description: 'The field is open to community annotation.' },
        closed: { type: 'boolean', description: 'Voting on the field is closed (only its authors still vote).' },
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
    code: params => `annotation_suggestions(${JSON.stringify(params.field.key)}${params.category === undefined ? '' : `, ${JSON.stringify(params.category)}`})`,
  }),
  defineAction({
    type: 'annotation.vote',
    title: 'Vote on a suggested label',
    summary: 'Vote a suggested label of a category up or down (none takes the person\'s vote back) and publish that vote alone: the person\'s own file in the community annotation repository is written as published now plus this vote (a pull request when they cannot write to the repository), which others see on their next Pull. Nothing else of the person\'s is published, and a vote that changes nothing publishes nothing. Asked of the person first; the history cannot take it back. Refused until the person has connected the repository and signed in to GitHub.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category', 'suggestion', 'vote'],
      properties: {
        field: CATEGORY_FIELD,
        category: CATEGORY_LABEL,
        suggestion: { type: 'string', minLength: 1, examples: ['CD4+ T cell'], description: 'The suggestion, by its id or its label (annotation_suggestions); suggestions with the same label are one suggestion.' },
        vote: { enum: [...ANNOTATION_VOTES], description: 'up, down, or none to take the person\'s vote back.' },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'publishes',
    confirmAt: 'handler',
    acts: { one: 'vote published', other: 'votes published', when: (params, outcome) => outcome?.published !== 'unchanged' },
    result: {
      type: 'object', additionalProperties: false, required: ['repository', 'published', 'pull_request', 'suggestion', 'vote', 'up', 'down', 'not_published'],
      properties: {
        repository: { type: 'string', description: 'The GitHub repository of the community annotation.' },
        published: { enum: ['repository', 'pull-request', 'unchanged'], description: 'Where the vote went: written to the repository, in a pull request its authors merge, or nowhere (it was already so).' },
        pull_request: { type: ['string', 'null'], description: 'The pull request, when it went to one.' },
        suggestion: { type: 'string', description: 'The label voted on.' },
        vote: { enum: [...ANNOTATION_VOTES], description: 'The person\'s vote on it now.' },
        up: { ...COUNT, description: 'Its upvotes now.' },
        down: { ...COUNT, description: 'Its downvotes now.' },
        not_published: { type: ['integer', 'null'], minimum: 0, description: 'The person\'s other changes still not published (null when not known).' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.vote === 'none'
      ? `Took back the vote on ${quote(params.suggestion)} for ${quote.bare(params.category)} of ${quote.bare(params.field.key)}`
      : `Voted ${quote(params.suggestion)} ${params.vote} for ${quote.bare(params.category)} of ${quote.bare(params.field.key)}`),
    code: params => `annotation_vote(${JSON.stringify(params.field.key)}, ${JSON.stringify(params.category)}, ${JSON.stringify(params.suggestion)}, ${JSON.stringify(params.vote)})`,
  }),
  defineAction({
    type: 'annotation.suggest',
    title: 'Suggest a label',
    summary: 'Suggest a label for a category in the person\'s name, with their upvote, as the voting dialog\'s New suggestion does, and publish that suggestion alone: the person\'s own file in the community annotation repository is written as published now plus this suggestion (a pull request when they cannot write to the repository), which others see on their next Pull. A label already suggested for the category is refused with its id (vote on it instead). Asked of the person first; the history cannot take it back. Refused until the person has connected the repository and signed in to GitHub.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category', 'label'],
      properties: {
        field: CATEGORY_FIELD,
        category: CATEGORY_LABEL,
        label: { type: 'string', minLength: 1, examples: ['CD4+ T cell'], description: 'The label suggested.' },
        ontology_id: { type: 'string', minLength: 1, examples: ['CL:0000624'], description: 'Its ontology term, when known.' },
        evidence: { type: 'string', minLength: 1, description: 'Why: the markers or reasoning behind it.' },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'publishes',
    confirmAt: 'handler',
    acts: { one: 'suggestion published', other: 'suggestions published' },
    result: {
      type: 'object', additionalProperties: false, required: ['repository', 'published', 'pull_request', 'id', 'label', 'not_published'],
      properties: {
        repository: { type: 'string', description: 'The GitHub repository of the community annotation.' },
        published: { enum: ['repository', 'pull-request'], description: 'Where the suggestion went: written to the repository, or in a pull request its authors merge.' },
        pull_request: { type: ['string', 'null'], description: 'The pull request, when it went to one.' },
        id: { type: 'string', description: 'The suggestion\'s id (annotation_vote takes it).' },
        label: { type: 'string', description: 'The label suggested.' },
        not_published: { type: ['integer', 'null'], minimum: 0, description: 'The person\'s other changes still not published (null when not known).' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Suggested ${quote(params.label)} for ${quote.bare(params.category)} of ${quote.bare(params.field.key)}`,
    code: params => `annotation_suggest(${JSON.stringify(params.field.key)}, ${JSON.stringify(params.category)}, ${JSON.stringify(params.label)})`,
  }),
]);
