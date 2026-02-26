process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_GATE_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_REASONER_ENABLED = 'true';
process.env.OPENROUTER_API_KEY = 'test-key';

const llmClient = require('../src/services/openRouterMatcher/llmClient');
const retrievalService = require('../src/services/openRouterMatcher/marketRetrieval');
const matchConfig = require('../src/services/openRouterMatcher/config');

describe('openRouter matcher helper utilities', () => {
  test('parseJsonResponse supports fenced and inline JSON', () => {
    const fenced = '```json\n{"has_claim": true, "domain": "finance"}\n```';
    const parsedFenced = llmClient.parseJsonResponse(fenced);
    expect(parsedFenced).toMatchObject({
      has_claim: true,
      domain: 'finance'
    });

    const inline = 'Result: {"has_claim": false, "domain": null}';
    const parsedInline = llmClient.parseJsonResponse(inline);
    expect(parsedInline).toMatchObject({
      has_claim: false,
      domain: null
    });
  });

  test('buildTsQueryExpression uses websearch_to_tsquery by default and can fall back to plainto', () => {
    expect(typeof retrievalService.buildTsQueryExpression(2)).toBe('string');
    expect(retrievalService.buildTsQueryExpression(2)).toContain('websearch_to_tsquery');

    const originalWebsearch = matchConfig.retrieval.websearchToTsquery;
    matchConfig.retrieval.websearchToTsquery = false;
    try {
      expect(retrievalService.buildTsQueryExpression(2)).toContain('plainto_tsquery');
    } finally {
      matchConfig.retrieval.websearchToTsquery = originalWebsearch;
    }
  });
});

describe('openRouter post match pipeline hardening', () => {
  const makeQueryMock = (queryLog, tableNames = []) => {
    const tableSet = new Set(tableNames);
    return async (sql) => {
      queryLog.push(String(sql));

      if (String(sql).includes('information_schema.tables')) {
        return {
          rows: Array.from(tableSet).map((table_name) => ({ table_name }))
        };
      }

      if (String(sql).includes('SELECT table_schema = \'public\'')) {
        return {
          rows: [{ has_extension: true }]
        };
      }

      if (String(sql).includes('INSERT INTO propositions')) {
        throw new Error('simulated proposition insert failure');
      }

      return { rows: [] };
    };
  };

  const buildDbMock = (queryMock) => ({
    getPool: () => ({
      connect: async () => ({
        query: queryMock,
        release: jest.fn()
      })
    }),
    query: queryMock
  });

  const runPipelineWithMocks = async (params) => {
    const {
      queryLog,
      claimGateResult,
      candidates = [],
      reasonerResult,
      runSafeReasonerMock
    } = params;

    const tableNames = params.tableNames || [
      'post_analysis',
      'post_market_matches',
      'post_market_links',
      'propositions',
      'prop_relations',
      'conditional_flags',
      'post_critiques',
      'verification_actions'
    ];

    const queryMock = makeQueryMock(queryLog, tableNames);
    jest.resetModules();
    jest.doMock('../src/db', () => buildDbMock(queryMock));

    const claimGateMock = {
      runSafeGate: jest.fn().mockResolvedValue(claimGateResult || {
        has_claim: true,
        domain: 'finance',
        claim_summary: 'Fed interest rate policy',
        entities: ['Federal Reserve']
      })
    };

    const retrievalMock = {
      retrieveCandidateMarkets: jest.fn().mockResolvedValue(candidates)
    };

    const reasonerModuleMock = {
      runSafeReasoner: runSafeReasonerMock
        || jest.fn().mockResolvedValue(reasonerResult || null)
    };

    jest.doMock('../src/services/openRouterMatcher/claimGate', () => claimGateMock);
    jest.doMock('../src/services/openRouterMatcher/marketRetrieval', () => retrievalMock);
    jest.doMock('../src/services/openRouterMatcher/argumentExtractor', () => reasonerModuleMock);

    const pipeline = require('../src/services/openRouterMatcher/postMatchPipeline');
    const result = await pipeline.processPostForTesting(1234, 'The Fed will cut rates after rate hike cycle');
    return { result, claimGateMock, retrievalMock, reasonerModuleMock };
  };

  test('reasoner persistence is guarded by SAVEPOINT rollback on error', async () => {
    const queryLog = [];

    const { result, reasonerModuleMock } = await runPipelineWithMocks({
      queryLog,
      reasonerResult: {
        propositions: [
          {
            label: 'P1',
            prop_type: 'premise',
            content: 'The Federal Reserve will lower rates',
            confidence_level: 'prediction',
            negated: false
          }
        ],
        relations: [],
        conditional_flags: [],
        critiques: [],
        best_market: null
      },
      candidates: [
        {
          event_id: 501,
          title: 'Fed rates',
          match_score: 0.87,
          match_method: 'hybrid_v1'
        }
      ]
    });

    expect(result.status).toBe('complete');
    expect(result.reasoner_match).toBe(false);
    expect(reasonerModuleMock.runSafeReasoner).toHaveBeenCalledTimes(1);

    const hasSavepoint = queryLog.some((sql) => sql.includes('SAVEPOINT reasoner_output'));
    const hasRollbackTo = queryLog.some((sql) => sql.includes('ROLLBACK TO SAVEPOINT reasoner_output'));
    const hasRelease = queryLog.some((sql) => sql.includes('RELEASE SAVEPOINT reasoner_output'));

    expect(hasSavepoint).toBe(true);
    expect(hasRollbackTo).toBe(true);
    expect(hasRelease).toBe(false);

    const committed = queryLog.some((sql) => sql.includes('COMMIT'));
    expect(committed).toBe(true);
  });

  test('persists hybrid retrieval candidates when reasoner is disabled', async () => {
    const queryLog = [];
    const { result, reasonerModuleMock } = await runPipelineWithMocks({
      queryLog,
      tableNames: [
        'post_analysis',
        'post_market_matches'
      ],
      reasonerResult: {
        propositions: [
          {
            label: 'P1',
            prop_type: 'premise',
            content: 'The Fed will cut rates',
            confidence_level: 'prediction'
          }
        ],
        relations: [],
        conditional_flags: [],
        critiques: [],
        best_market: null
      },
      candidates: [
        {
          event_id: 601,
          title: 'Fed rates',
          match_score: 0.71,
          match_method: 'hybrid_v1'
        }
      ],
      runSafeReasonerMock: jest.fn().mockResolvedValue(null)
    });

    expect(result.status).toBe('complete');
    expect(result.candidate_count).toBe(1);
    expect(reasonerModuleMock.runSafeReasoner).not.toHaveBeenCalled();

    const wroteCandidates = queryLog.some((sql) => sql.includes('INSERT INTO post_market_matches'));
    expect(wroteCandidates).toBe(true);
  });

  test('does not fail when reasoner output is malformed; keeps candidate path and completes', async () => {
    const queryLog = [];
    const reasonerError = new Error('malformed llm output');
    const { result } = await runPipelineWithMocks({
      queryLog,
      reasonerResult: null,
      runSafeReasonerMock: jest.fn().mockRejectedValue(reasonerError),
      candidates: [
        {
          event_id: 801,
          title: 'Fed rates',
          match_score: 0.76,
          match_method: 'hybrid_v1'
        }
      ]
    });

    expect(result.status).toBe('complete');
    expect(result.candidate_count).toBe(1);

    const hasCommit = queryLog.some((sql) => sql.includes('COMMIT'));
    const hasErrorLog = queryLog.some((sql) => sql.includes('post_match_pipeline_runs'));
    expect(hasCommit).toBe(true);
    expect(hasErrorLog).toBe(true);
  });
});
