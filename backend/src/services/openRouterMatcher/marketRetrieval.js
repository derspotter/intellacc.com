const db = require('../../db');
const config = require('./config');
const { embedText } = require('./embeddingService');

const MIN_SEARCH_LENGTH = 8;
let capabilityCache = null;

const cleanText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim();

const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeDomain = (value) => config.normalizeDomain(value);

const normalizeSearchText = (claimSummary, entities = []) => {
  const normalized = [claimSummary, ...(Array.isArray(entities) ? entities : [])]
    .map((item) => cleanText(item))
    .filter(Boolean);

  return normalized.join(' ');
};

const mapCandidateRows = (rows) => rows.map((row) => ({
  event_id: Number(row.event_id),
  title: row.title || '',
  closing_date: row.closing_date || null,
  match_score: toNumber(row.match_score, 0),
  vec_score: toNumber(row.vec_score, 0),
  text_score: toNumber(row.text_score, 0)
}));

const buildTsQueryExpression = (searchTextParamIndex) => (
  config.retrieval.websearchToTsquery
    ? `websearch_to_tsquery('english', $${searchTextParamIndex})`
    : `plainto_tsquery('english', $${searchTextParamIndex})`
);

const withDomainFilter = (hasDomain, domain, placeholderIndex) => {
  if (!hasDomain || !domain) {
    return '';
  }

  return ` AND e.domain = $${placeholderIndex}`;
};

const getSearchExpression = (hasSearchVectorColumn) => (
  hasSearchVectorColumn
    ? 'COALESCE(e.search_vector, to_tsvector(\'english\', COALESCE(e.title, \'\') || \' \' || COALESCE(e.details, \'\')))'
    : 'to_tsvector(\'english\', COALESCE(e.title, \'\') || \' \' || COALESCE(e.details, \'\'))'
);

const getCapabilities = async () => {
  if (capabilityCache) {
    return capabilityCache;
  }

  const extensionResult = await db.query(`
    SELECT EXISTS(
      SELECT 1
      FROM pg_extension
      WHERE extname = 'vector'
    ) AS has_vector_extension
  `);

  const columnResult = await db.query(`
    SELECT
      EXISTS(
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'events'
           AND column_name = 'embedding'
      ) AS has_embedding_column,
      EXISTS(
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'events'
           AND column_name = 'search_vector'
      ) AS has_search_vector_column,
      EXISTS(
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'events'
           AND column_name = 'domain'
      ) AS has_domain_column
  `);

  capabilityCache = {
    hasVector: extensionResult.rows[0]?.has_vector_extension === true
      && columnResult.rows[0]?.has_embedding_column === true,
    hasEmbeddingColumn: columnResult.rows[0]?.has_embedding_column === true,
    hasSearchVectorColumn: columnResult.rows[0]?.has_search_vector_column === true,
    hasDomainColumn: columnResult.rows[0]?.has_domain_column === true
  };

  return capabilityCache;
};

const queryHybrid = async ({
  claimEmbedding,
  searchText,
  domain,
  candidateLimit,
  searchExpression,
  capabilities
}) => {
  const params = [claimEmbedding, searchText, candidateLimit];
  const domainFilter = withDomainFilter(capabilities.hasDomainColumn, domain, 4);

  if (capabilities.hasDomainColumn && domain) {
    params.push(domain);
  }

  const query = `
    WITH q AS (
      SELECT ${buildTsQueryExpression(2)} AS q
    ),
    vector_matches AS (
      SELECT
        e.id AS event_id,
        e.closing_date,
        1 - (e.embedding <=> $1::vector) AS vec_score,
        ROW_NUMBER() OVER (ORDER BY e.embedding <=> $1::vector) AS vec_rank
      FROM events e
      WHERE e.outcome IS NULL
        AND e.closing_date > NOW()
        AND e.embedding IS NOT NULL
        ${domainFilter}
      ORDER BY e.embedding <=> $1::vector
      LIMIT 60
    ),
    text_matches AS (
      SELECT
        e.id AS event_id,
        e.closing_date,
        e.title,
        ts_rank(${searchExpression}, q.q) AS text_score,
        ROW_NUMBER() OVER (ORDER BY ts_rank(${searchExpression}, q.q) DESC) AS text_rank
      FROM events e
      JOIN q ON TRUE
      WHERE e.outcome IS NULL
        AND e.closing_date > NOW()
        ${domainFilter}
        AND q.q IS NOT NULL
        AND ${searchExpression} @@ q.q
      ORDER BY ts_rank(${searchExpression}, q.q) DESC
      LIMIT 60
    )
    SELECT
      COALESCE(v.event_id, t.event_id) AS event_id,
      COALESCE(t.title, e.title) AS title,
      COALESCE(v.closing_date, t.closing_date, e.closing_date) AS closing_date,
      COALESCE(v.vec_score, 0) AS vec_score,
      COALESCE(t.text_score, 0) AS text_score,
      (
        (1.0 / (60 + COALESCE(v.vec_rank, 999)))
        + (1.0 / (60 + COALESCE(t.text_rank, 999)))
      ) AS match_score
    FROM vector_matches v
    FULL OUTER JOIN text_matches t ON v.event_id = t.event_id
    LEFT JOIN events e ON e.id = COALESCE(v.event_id, t.event_id)
    ORDER BY match_score DESC, event_id DESC
    LIMIT $3
  `;

  const result = await db.query(query, params);
  return mapCandidateRows(result.rows);
};

const retrieveCandidateMarkets = async (claimSummary, entities, domain) => {
  if (!config.retrieval.enabled) {
    return [];
  }

  const normalizedClaim = cleanText(claimSummary);
  const searchText = normalizeSearchText(normalizedClaim, entities);
  if (!searchText || searchText.length < MIN_SEARCH_LENGTH) {
    return [];
  }

  const capabilities = await getCapabilities();
  const searchExpression = getSearchExpression(capabilities.hasSearchVectorColumn);
  const effectiveDomain = normalizeDomain(domain);
  const candidateLimit = Math.max(1, Math.min(config.retrieval.candidateLimit, 30));

  if (!capabilities.hasVector || !capabilities.hasEmbeddingColumn) {
    return [];
  }

  try {
    const embedding = await embedText(normalizedClaim);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const withDomain = await queryHybrid({
      claimEmbedding: vectorLiteral,
      searchText,
      domain: effectiveDomain,
      candidateLimit,
      searchExpression,
      capabilities
    });

    if (withDomain.length > 0 || !effectiveDomain) {
      return withDomain;
    }

    // Backward-compatibility fallback for legacy events with NULL domain.
    return queryHybrid({
      claimEmbedding: vectorLiteral,
      searchText,
      domain: null,
      candidateLimit,
      searchExpression,
      capabilities
    });
  } catch (error) {
    console.error('[Matcher] Hybrid retrieval failed:', error.message);
    return [];
  }
};

module.exports = {
  retrieveCandidateMarkets,
  loadCapabilities: getCapabilities,
  buildTsQueryExpression,
  normalizeSearchText
};
