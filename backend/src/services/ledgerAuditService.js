// backend/src/services/ledgerAuditService.js
const db = require('../db');
const axios = require('axios');

const PREDICTION_ENGINE_URL = process.env.PREDICTION_ENGINE_URL || 'http://prediction-engine:3001';
const PREDICTION_ENGINE_AUTH_TOKEN = process.env.PREDICTION_ENGINE_AUTH_TOKEN;

async function enginePost(path, data = {}) {
  try {
    const response = await axios.post(`${PREDICTION_ENGINE_URL}${path}`, data, {
      headers: {
        'Content-Type': 'application/json',
        ...(PREDICTION_ENGINE_AUTH_TOKEN ? { 'x-engine-token': PREDICTION_ENGINE_AUTH_TOKEN } : {})
      },
      timeout: 10000
    });
    return response.data;
  } catch (err) {
    console.error(`Error calling Rust engine at ${path}:`, err.message);
    if (err.response && err.response.data) {
      return { valid: false, error: err.response.data.error || err.message };
    }
    return { valid: false, error: err.message };
  }
}

class LedgerAuditService {
  async runFullAudit() {
    console.log('[LedgerAudit] Starting full cross-service ledger audit...');
    
    const results = {
      sqlAuditIssuesFound: 0,
      sqlAuditDetails: null,
      lmsrConsistencyFailures: [],
      balanceInvariantFailures: []
    };

    // 1. Run internal PostgreSQL ledger audit function
    try {
      console.log('[LedgerAudit] Executing SQL run_ledger_audit()...');
      await db.query('SELECT run_ledger_audit()');
      
      // Fetch latest summary from the view (issues in the last hour)
      const summaryResult = await db.query(
        "SELECT * FROM ledger_audit_summary WHERE audit_hour >= DATE_TRUNC('hour', NOW() - INTERVAL '1 hour')"
      );
      
      // Calculate total current issues
      let totalIssues = 0;
      for (const row of summaryResult.rows) {
          if (row.severity === 'error' || row.severity === 'warn') {
              totalIssues += parseInt(row.issue_count || 0, 10);
          }
      }
      results.sqlAuditIssuesFound = totalIssues;
      results.sqlAuditDetails = summaryResult.rows;
      console.log(`[LedgerAudit] SQL audit completed. Active issue records found: ${summaryResult.rows.length}`);
    } catch (err) {
      console.error('[LedgerAudit] SQL run_ledger_audit failed:', err);
      results.sqlAuditDetails = { error: err.message };
    }

    // 2. Cross-reference LMSR consistency for active events
    try {
      const activeEvents = await db.query('SELECT id FROM events WHERE outcome IS NULL ORDER BY created_at DESC LIMIT 100');
      console.log(`[LedgerAudit] Checking LMSR consistency for ${activeEvents.rowCount} active events via Rust Engine...`);
      
      for (const row of activeEvents.rows) {
        const engineResponse = await enginePost('/lmsr/verify-consistency', { event_id: row.id });
        if (!engineResponse.valid) {
          results.lmsrConsistencyFailures.push({ event_id: row.id, ...engineResponse });
        }
      }
    } catch (err) {
      console.error('[LedgerAudit] LMSR consistency check failed:', err);
      results.lmsrConsistencyFailures.push({ error: err.message });
    }

    // 3. Cross-reference balance invariants for users with recent activity
    try {
      const activeUsers = await db.query(`
        SELECT DISTINCT user_id 
        FROM user_shares 
        WHERE last_updated >= NOW() - INTERVAL '24 hours'
        LIMIT 100
      `);
      console.log(`[LedgerAudit] Checking balance invariants for ${activeUsers.rowCount} recently active users via Rust Engine...`);
      
      for (const row of activeUsers.rows) {
        const engineResponse = await enginePost('/lmsr/verify-balance-invariant', { user_id: row.user_id });
        if (!engineResponse.valid) {
          results.balanceInvariantFailures.push({ user_id: row.user_id, ...engineResponse });
        }
      }
    } catch (err) {
      console.error('[LedgerAudit] Balance invariant check failed:', err);
      results.balanceInvariantFailures.push({ error: err.message });
    }

    console.log('[LedgerAudit] Full audit complete.');
    return results;
  }
}

module.exports = new LedgerAuditService();
