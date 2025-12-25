/**
 * @fileoverview Cell Annotation Platform (CAP) API client.
 *
 * Provides access to celltype.info GraphQL API for:
 * - Cell type ontology lookups
 * - Marker gene information
 * - Community feedback scores
 * - Synonym detection
 *
 * @module community-annotations/cap-api
 * @see https://celltype.info/docs/python-client-for-cap-api
 */

const CAP_GRAPHQL_URL = 'https://celltype.info/graphql';

/**
 * Execute a GraphQL query against CAP API.
 * @param {string} query - GraphQL query string
 * @param {Object} [variables={}] - Query variables
 * @returns {Promise<Object>} - Response data
 */
async function executeQuery(query, variables = {}) {
  const response = await fetch(CAP_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`CAP API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(`CAP GraphQL error: ${result.errors[0].message}`);
  }

  return result.data;
}

/**
 * Search for cell types by name/term.
 * Returns matching cell labels with ontology info, marker genes, and synonyms.
 *
 * @param {string} searchTerm - Search term (e.g., "macrophage", "T cell")
 * @param {number} [limit=10] - Maximum results to return
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
export async function searchCellTypes(searchTerm, limit = 10) {
  if (!searchTerm?.trim()) return [];

  const normalizedSearch = searchTerm.trim().toLowerCase();

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

  // Request more results to filter client-side (CAP's search can return poor matches)
  const data = await executeQuery(query, { limit: Math.max(limit * 5, 50), name: searchTerm.trim() });
  const results = data?.lookupCells || [];

  // Filter to results where search term appears anywhere in name/fullName/synonyms/markerGenes (case-insensitive)
  const filtered = results.filter((r) => {
    if ((r.name || '').toLowerCase().includes(normalizedSearch)) return true;
    if ((r.fullName || '').toLowerCase().includes(normalizedSearch)) return true;
    if (r.synonyms?.some((s) => (s || '').toLowerCase().includes(normalizedSearch))) return true;
    if (r.markerGenes?.some((g) => (g || '').toLowerCase().includes(normalizedSearch))) return true;
    if (r.canonicalMarkerGenes?.some((g) => (g || '').toLowerCase().includes(normalizedSearch))) return true;
    return false;
  });

  return filtered.slice(0, limit);
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
