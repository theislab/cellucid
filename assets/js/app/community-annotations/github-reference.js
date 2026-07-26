/**
 * Exact current GitHub repository-reference contract used by annotation auth,
 * storage, cache scoping, sync, and the worker projection.
 */

const GITHUB_ACCOUNT =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_BRANCH_SAFE_SUBSET =
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const GITHUB_OBJECT_ID = /^[0-9a-f]{40}$/i;

export function isCanonicalGitHubAccount(value) {
  return typeof value === 'string' && GITHUB_ACCOUNT.test(value);
}

export function isCanonicalGitHubRepositoryName(value) {
  return (
    typeof value === 'string' &&
    GITHUB_REPOSITORY.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.endsWith('.git')
  );
}

export function isCanonicalGitHubBranch(value) {
  if (
    typeof value !== 'string' ||
    !GITHUB_BRANCH_SAFE_SUBSET.test(value) ||
    value.startsWith('refs/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    GITHUB_OBJECT_ID.test(value)
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) =>
      segment &&
      !segment.startsWith('.') &&
      !segment.endsWith('.lock')
    );
}

export function parseCanonicalGitHubRepositoryReference(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    Array.from(value).length > 1280 ||
    /[?#]/.test(value)
  ) {
    return null;
  }
  const atIndex = value.lastIndexOf('@');
  const ownerRepo = atIndex < 0 ? value : value.slice(0, atIndex);
  const ref = atIndex < 0 ? null : value.slice(atIndex + 1);
  if (ref !== null && !isCanonicalGitHubBranch(ref)) return null;

  const parts = ownerRepo.split('/');
  if (
    parts.length !== 2 ||
    !isCanonicalGitHubAccount(parts[0]) ||
    !isCanonicalGitHubRepositoryName(parts[1])
  ) {
    return null;
  }
  const [owner, repo] = parts;
  const canonicalOwnerRepo = `${owner}/${repo}`;
  return {
    owner,
    repo,
    ownerRepo: canonicalOwnerRepo,
    ref,
    ownerRepoRef:
      ref === null ? canonicalOwnerRepo : `${canonicalOwnerRepo}@${ref}`,
  };
}

export function isCanonicalGitHubRepositoryFullName(value) {
  const parsed = parseCanonicalGitHubRepositoryReference(value);
  return parsed !== null && parsed.ref === null;
}
