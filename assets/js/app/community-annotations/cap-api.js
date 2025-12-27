/**
 * @fileoverview Cell Annotation Platform (CAP) API client.
 *
 * Provides access to celltype.info GraphQL API for:
 * - Cell type ontology lookups
 * - Marker gene information
 * - Community feedback scores
 * - Synonym detection
 *
 * Privacy: search terms are sent to https://celltype.info/graphql.
 *
 * @module community-annotations/cap-api
 * @see https://celltype.info/docs/python-client-for-cap-api
 */

const CAP_GRAPHQL_URL = 'https://celltype.info/graphql';
const CAP_DEFAULT_TIMEOUT_MS = 12_000;

function toCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeForSearch(value) {
  const s = toCleanString(value);
  if (!s) return '';
  try {
    return s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

function tokenizeSearch(value) {
  const norm = normalizeForSearch(value);
  if (!norm) return [];
  const parts = norm.split(' ').filter(Boolean);
  const isMulti = parts.length > 1;
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (isMulti && p.length < 2) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function isNetworkError(err) {
  // Browser fetch() commonly throws TypeError on network failure / CORS / DNS.
  if (err instanceof TypeError) return true;
  const msg = toCleanString(err?.message || '');
  return /failed to fetch|load failed|networkerror|fetch failed/i.test(msg);
}

/**
 * Execute a GraphQL query against CAP API.
 * @param {string} query - GraphQL query string
 * @param {Object} [variables={}] - Query variables
 * @param {Object} [options={}]
 * @param {number} [options.timeoutMs=12000] - Request timeout.
 * @returns {Promise<Object>} - Response data
 */
async function executeQuery(query, variables = {}, options = {}) {
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : CAP_DEFAULT_TIMEOUT_MS;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller?.signal;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (controller && timeoutMs > 0) {
    timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, timeoutMs);
  }

  try {
    const response = await fetch(CAP_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: signal || undefined
    });

    const text = await response.text();
    let result = null;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      result = null;
    }

    if (!response.ok) {
      const msg =
        toCleanString(result?.errors?.[0]?.message) ||
        toCleanString(result?.message) ||
        toCleanString(text) ||
        `HTTP ${response.status}`;
      throw new Error(`CAP API error: ${response.status} ${msg}`);
    }

    if (!result || typeof result !== 'object') {
      throw new Error('CAP API returned invalid JSON');
    }

    if (result.errors?.length) {
      throw new Error(`CAP GraphQL error: ${result.errors[0].message}`);
    }

    return result.data;
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`CAP request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (isNetworkError(err)) {
      throw new Error('CAP unreachable (network error)');
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function computeStringMatchScore(value, ctx) {
  const raw = toCleanString(value);
  if (!raw) return 0;

  const rawLower = raw.toLowerCase();
  const norm = normalizeForSearch(raw);

  const searchLower = ctx?.searchLower || '';
  const searchNorm = ctx?.searchNorm || '';
  const tokens = Array.isArray(ctx?.tokens) ? ctx.tokens : [];

  let best = 0;

  if (searchLower && rawLower === searchLower) best = Math.max(best, 1000);
  if (searchNorm && norm === searchNorm) best = Math.max(best, 950);

  if (searchLower && rawLower.startsWith(searchLower)) {
    best = Math.max(best, 900 - Math.min(250, rawLower.length - searchLower.length));
  }
  if (searchNorm && norm.startsWith(searchNorm)) {
    best = Math.max(best, 850 - Math.min(250, norm.length - searchNorm.length));
  }

  if (searchLower) {
    const idx = rawLower.indexOf(searchLower);
    if (idx >= 0) best = Math.max(best, 700 - idx);
  }
  if (searchNorm) {
    const idx = norm.indexOf(searchNorm);
    if (idx >= 0) best = Math.max(best, 650 - idx);
  }

  if (tokens.length) {
    let matchCount = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (norm.includes(t)) matchCount += 1;
    }
    if (matchCount === tokens.length) best = Math.max(best, 600);
    else if (matchCount > 0) best = Math.max(best, 420 + Math.round((matchCount / tokens.length) * 120));
  }

  return best;
}

function getMarkerGeneMatchCount(result, markerGenes) {
  const genes = Array.isArray(markerGenes) ? markerGenes : [];
  if (!genes.length) return 0;

  const wanted = new Set();
  for (const g of genes.slice(0, 50)) {
    const key = toCleanString(g).replace(/\s+/g, '').toUpperCase();
    if (key) wanted.add(key);
  }
  if (!wanted.size) return 0;

  const all = [];
  if (Array.isArray(result?.markerGenes)) all.push(...result.markerGenes);
  if (Array.isArray(result?.canonicalMarkerGenes)) all.push(...result.canonicalMarkerGenes);

  const matched = new Set();
  for (const g of all.slice(0, 200)) {
    const key = toCleanString(g).replace(/\s+/g, '').toUpperCase();
    if (!key) continue;
    if (wanted.has(key)) matched.add(key);
  }
  return matched.size;
}

function computeCellTypeRelevance(result, ctx, { markerGenes = null } = {}) {
  if (!result || typeof result !== 'object') return { score: 0, markerMatchCount: 0 };

  const markerMatchCount = getMarkerGeneMatchCount(result, markerGenes);
  let score = 0;

  score = Math.max(score, computeStringMatchScore(result?.ontologyTermId, ctx) * 1.25);
  score = Math.max(score, computeStringMatchScore(result?.ontologyTerm, ctx) * 1.05);
  score = Math.max(score, computeStringMatchScore(result?.fullName, ctx) * 1.0);
  score = Math.max(score, computeStringMatchScore(result?.name, ctx) * 1.0);

  if (Array.isArray(result?.synonyms)) {
    for (const syn of result.synonyms.slice(0, 50)) {
      score = Math.max(score, computeStringMatchScore(syn, ctx) * 0.85);
    }
  }

  if (Array.isArray(result?.markerGenes)) {
    for (const g of result.markerGenes.slice(0, 80)) {
      score = Math.max(score, computeStringMatchScore(g, ctx) * 0.8);
    }
  }

  if (Array.isArray(result?.canonicalMarkerGenes)) {
    for (const g of result.canonicalMarkerGenes.slice(0, 80)) {
      score = Math.max(score, computeStringMatchScore(g, ctx) * 0.75);
    }
  }

  if (markerMatchCount > 0) {
    score += 140 * markerMatchCount;
    if (Array.isArray(markerGenes) && markerMatchCount >= markerGenes.length) score += 180;
  }

  return { score, markerMatchCount };
}

/**
 * Search for cell types by name/term.
 * Returns matching cell labels with ontology info, marker genes, and synonyms.
 *
 * @param {string} searchTerm - Search term (e.g., "macrophage", "T cell")
 * @param {number} [limit=10] - Maximum results to return
 * @param {Object} [options={}]
 * @param {string[]|null} [options.markerGenes=null] - Optional marker gene list (improves marker searches).
 * @returns {Promise<Array<{
 *   name: string,
 *   fullName: string,
 *   ontologyTerm: string | null,
 *   ontologyTermId: string | null,
 *   markerGenes: string[],
 *   canonicalMarkerGenes: string[],
 *   synonyms: string[]
 * }>>}
 */
export async function searchCellTypes(searchTerm, limit = 10, options = {}) {
  if (!searchTerm?.trim()) return [];

  const trimmed = searchTerm.trim();
  const searchLower = trimmed.toLowerCase();
  const searchNorm = normalizeForSearch(trimmed);
  const tokens = tokenizeSearch(trimmed);
  const ctx = { searchLower, searchNorm, tokens };
  const markerGenes = Array.isArray(options?.markerGenes) ? options.markerGenes : null;

  const query = `
    query SearchCells($limit: Int!, $name: String!) {
      lookupCells(options: { limit: $limit }, search: { name: $name }) {
        name
        fullName
        ontologyTerm
        ontologyTermId
        markerGenes
        canonicalMarkerGenes
        synonyms
        rationale
      }
    }
  `;

  const maxClient = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 10;
  // Request more results to re-rank client-side (CAP search ordering can be noisy).
  const expandedLimit = Math.min(200, Math.max(maxClient * 10, 80));
  const data = await executeQuery(query, { limit: expandedLimit, name: trimmed });
  const results = data?.lookupCells || [];

  const scored = [];
  const seen = new Set();
  for (const r of results) {
    const idKey = toCleanString(r?.ontologyTermId).toLowerCase();
    const nameKey = normalizeForSearch(r?.fullName || r?.name || '');
    const key = idKey ? `id:${idKey}` : (nameKey ? `name:${nameKey}` : '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);

    const { score, markerMatchCount } = computeCellTypeRelevance(r, ctx, { markerGenes });
    if (!score) continue;
    if (markerGenes?.length && markerMatchCount <= 0) continue;
    scored.push({ r, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aName = toCleanString(a.r?.fullName || a.r?.name).toLowerCase();
    const bName = toCleanString(b.r?.fullName || b.r?.name).toLowerCase();
    if (aName && bName && aName !== bName) return aName.localeCompare(bName);
    const aId = toCleanString(a.r?.ontologyTermId).toLowerCase();
    const bId = toCleanString(b.r?.ontologyTermId).toLowerCase();
    if (aId && bId && aId !== bId) return aId.localeCompare(bId);
    return 0;
  });

  return scored.slice(0, maxClient).map((s) => s.r);
}

/**
 * Look up a specific cell type by ontology ID (e.g., "CL:0000625").
 *
 * @param {string} ontologyId - Cell Ontology ID
 * @returns {Promise<{
 *   name: string,
 *   fullName: string,
 *   ontologyTerm: string | null,
 *   ontologyTermId: string | null,
 *   markerGenes: string[],
 *   canonicalMarkerGenes: string[],
 *   synonyms: string[],
 *   rationale: string
 * } | null>}
 */
export async function lookupByOntologyId(ontologyId) {
  if (!ontologyId?.trim()) return null;

  // CAP doesn't have a direct ontology ID lookup, so we search by the ID
  const results = await searchCellTypes(ontologyId.trim(), 5);

  // Find exact match by ontologyTermId
  const match = results.find(
    (r) => r.ontologyTermId?.toLowerCase() === ontologyId.trim().toLowerCase()
  );

  return match || results[0] || null;
}

/**
 * Look up a cell type by exact name match.
 *
 * @param {string} name - Cell type name
 * @returns {Promise<Object | null>}
 */
export async function lookupByName(name) {
  if (!name?.trim()) return null;

  const results = await searchCellTypes(name.trim(), 5);

  // Find best match by fullName or name
  const normalizedSearch = name.trim().toLowerCase();
  const match = results.find(
    (r) =>
      r.fullName?.toLowerCase() === normalizedSearch ||
      r.name?.toLowerCase() === normalizedSearch
  );

  return match || results[0] || null;
}

/**
 * Get CAP community feedback for a cell type.
 *
 * @param {string} cellTypeName - Cell type name
 * @returns {Promise<{
 *   name: string,
 *   feedback: { agree: number, disagree: number, idk: number } | null,
 *   total: number,
 *   agreePercent: number
 * } | null>}
 */
export async function getCommunityFeedback(cellTypeName) {
  if (!cellTypeName?.trim()) return null;

  const query = `
    query GetFeedback($limit: Int!, $name: String!) {
      lookupCells(options: { limit: $limit }, search: { name: $name }) {
        name
        fullName
        scores {
          agree
          disagree
          idk
          total
        }
      }
    }
  `;

  const data = await executeQuery(query, { limit: 5, name: cellTypeName.trim() });
  const results = data?.lookupCells || [];

  if (!results.length) return null;

  // Find best match
  const normalizedSearch = cellTypeName.trim().toLowerCase();
  const label =
    results.find(
      (r) =>
        r.fullName?.toLowerCase() === normalizedSearch ||
        r.name?.toLowerCase() === normalizedSearch
    ) || results[0];

  if (!label?.scores) return null;

  const { agree = 0, disagree = 0, idk = 0, total = 0 } = label.scores;
  const agreePercent = total > 0 ? Math.round((agree / total) * 100) : 0;

  return {
    name: label.fullName || label.name,
    feedback: { agree, disagree, idk },
    total,
    agreePercent
  };
}

/**
 * Find synonyms for a cell type name.
 * Useful for detecting duplicate suggestions that use different names.
 *
 * @param {string} cellTypeName - Cell type name
 * @returns {Promise<{
 *   name: string,
 *   ontologyTermId: string | null,
 *   synonyms: string[],
 *   allNames: string[]
 * } | null>}
 */
export async function findSynonyms(cellTypeName) {
  if (!cellTypeName?.trim()) return null;

  const label = await lookupByName(cellTypeName);

  if (!label) return null;

  // Combine primary name, fullName, and synonyms
  const allNames = new Set([label.name]);
  if (label.fullName) allNames.add(label.fullName);
  if (label.ontologyTerm) allNames.add(label.ontologyTerm);
  if (label.synonyms?.length) {
    label.synonyms.filter((s) => s && s !== 'unknown').forEach((s) => allNames.add(s));
  }

  return {
    name: label.fullName || label.name,
    ontologyTermId: label.ontologyTermId,
    synonyms: label.synonyms?.filter((s) => s && s !== 'unknown') || [],
    allNames: [...allNames]
  };
}

/**
 * Check if two cell type names might be synonyms of each other.
 *
 * @param {string} name1 - First cell type name
 * @param {string} name2 - Second cell type name
 * @returns {Promise<{
 *   areSynonyms: boolean,
 *   sharedOntologyId: string | null,
 *   canonicalName: string | null
 * }>}
 */
export async function checkIfSynonyms(name1, name2) {
  if (!name1?.trim() || !name2?.trim()) {
    return { areSynonyms: false, sharedOntologyId: null, canonicalName: null };
  }

  const n1 = name1.trim().toLowerCase();
  const n2 = name2.trim().toLowerCase();

  if (n1 === n2) {
    return { areSynonyms: true, sharedOntologyId: null, canonicalName: name1.trim() };
  }

  // Look up both names
  const [result1, result2] = await Promise.all([findSynonyms(name1), findSynonyms(name2)]);

  // Check if they share an ontology ID
  if (result1?.ontologyTermId && result2?.ontologyTermId) {
    if (result1.ontologyTermId === result2.ontologyTermId) {
      return {
        areSynonyms: true,
        sharedOntologyId: result1.ontologyTermId,
        canonicalName: result1.name
      };
    }
  }

  // Check if one name appears in the other's synonyms
  if (result1?.allNames?.some((n) => n.toLowerCase() === n2)) {
    return {
      areSynonyms: true,
      sharedOntologyId: result1.ontologyTermId || null,
      canonicalName: result1.name
    };
  }

  if (result2?.allNames?.some((n) => n.toLowerCase() === n1)) {
    return {
      areSynonyms: true,
      sharedOntologyId: result2.ontologyTermId || null,
      canonicalName: result2.name
    };
  }

  return { areSynonyms: false, sharedOntologyId: null, canonicalName: null };
}

/**
 * Search datasets in CAP.
 *
 * @param {Object} [options={}]
 * @param {string} [options.search] - Search term
 * @param {number} [options.limit=20] - Max results
 * @returns {Promise<Array<Object>>}
 */
export async function searchDatasets({ search, limit = 20 } = {}) {
  const query = `
    query SearchDatasets($limit: Int!, $search: LookupDatasetsSearchInput) {
      lookupDatasets(options: { limit: $limit }, search: $search) {
        id
        name
        cellCount
      }
    }
  `;

  const searchInput = search ? { name: search } : null;
  const data = await executeQuery(query, { limit, search: searchInput });
  return data?.lookupDatasets || [];
}
