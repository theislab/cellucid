/**
 * @fileoverview Exact identity and repository-metadata assertions.
 *
 * These guards are the boundary between GitHub- or storage-supplied values and
 * the community annotation session. Every one of them either returns the exact
 * value or throws — there is no lenient coercion, because a silently accepted
 * malformed login, user key, or branch is written into annotation files.
 *
 * @module ui/modules/community-annotation/identity-assertions
 */

import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubRepositoryFullName,
} from '../../../community-annotations/github-reference.js';

export function assertExactGitHubLogin(value, label) {
  if (
    typeof value !== 'string' ||
    !isCanonicalGitHubAccount(value)
  ) {
    throw new Error(`${label} must be an exact GitHub account login`);
  }
  return value;
}

export function assertExactAnnotationUserKey(value, label) {
  if (
    value !== 'local' &&
    (
      typeof value !== 'string' ||
      !/^ghid_[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value.slice(5))) ||
      value !== `ghid_${Number(value.slice(5))}`
    )
  ) {
    throw new Error(`${label} must be "local" or an exact ghid identity`);
  }
  return value;
}

export function requireResolvedAnnotationBranch(sync) {
  const branch = sync?.branch;
  if (
    typeof branch !== 'string' ||
    !branch ||
    /^\s|\s$/.test(branch)
  ) {
    throw new Error(
      'GitHub did not provide an exact resolved branch for the annotation repository'
    );
  }
  return branch;
}

export function requireAnnotationBranchMode(meta) {
  if (
    meta === null ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    Object.keys(meta).length !== 1 ||
    !Object.hasOwn(meta, 'branchMode') ||
    (meta.branchMode !== 'default' && meta.branchMode !== 'explicit')
  ) {
    throw new Error(
      'Stored annotation repository metadata must contain exactly branchMode'
    );
  }
  return meta.branchMode;
}

export function requireGitHubRepositoryFullName(repoInfo) {
  const value = repoInfo?.full_name;
  if (!isCanonicalGitHubRepositoryFullName(value)) {
    throw new Error(
      'GitHub repository metadata must include an exact full_name'
    );
  }
  return value;
}
